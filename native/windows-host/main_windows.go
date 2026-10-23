package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func samePath(a, b string) bool {
	return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

func writeJSON(value any) error {
	return json.NewEncoder(os.Stdout).Encode(value)
}

func main() {
	if err := command(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "anubis-host:", err)
		os.Exit(1)
	}
}

func command(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: anubis-host.exe identity|validate-install|secure-runtime-pipe|prepare-update|install|uninstall|start|stop|status|service|console|broker-client [flags]")
	}
	if args[0] == "identity" {
		if len(args) != 1 {
			return errors.New("identity accepts no arguments")
		}
		i, err := currentIdentity()
		if err != nil {
			return err
		}
		systemDirectory, err := windows.GetSystemDirectory()
		if err != nil {
			return err
		}
		return writeJSON(struct {
			identity
			SystemDirectory string `json:"systemDirectory"`
		}{identity: i, SystemDirectory: systemDirectory})
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	name := flags.String("name", "AnubisHost", "AnubisHost or AnubisHost-QA-<unique-suffix>")
	var installDir, runtimePath, allowed, operation, target, sessionText *string
	var stdio *bool
	var runtimePipe *string
	var runtimePID *uint64
	var updateSource, updateHash *string
	var updateSize *int64
	if args[0] == "prepare-update" {
		updateSource = flags.String("source-file", "", "absolute local regular installer .exe")
		updateHash = flags.String("sha256", "", "expected installer SHA256")
		updateSize = flags.Int64("size", 0, "expected installer byte size, positive and at most 2 GiB")
	}
	if args[0] == "secure-runtime-pipe" {
		runtimePipe = flags.String("pipe", "", "exact host-generated own runtime pipe")
		runtimePID = flags.Uint64("server-pid", 0, "actual own runtime server PID")
	}
	if args[0] == "install" || args[0] == "validate-install" {
		installDir = flags.String("install-dir", "", "protected per-machine installation directory")
		runtimePath = flags.String("runtime-relative-path", runtimeFile, "fixed packaged runtime path within installation")
		if args[0] == "install" {
			allowed = flags.String("allow-user-sids", "", "comma-separated explicitly authorized account SIDs")
		}
	}
	if args[0] == "broker-client" {
		operation = flags.String("operation", "identity", "identity, list-sessions, or launch-context")
		target = flags.String("target", "", "system or user for launch-context")
		sessionText = flags.String("session", "", "explicit nonzero logged-on session ID")
		stdio = flags.Bool("stdio", false, "private Node-main bridge: request on stdin, full secret response on stdout (never log)")
	}
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected positional arguments")
	}
	if !servicePattern.MatchString(*name) {
		return errors.New("invalid service name")
	}
	switch args[0] {
	case "prepare-update":
		result, err := prepareUpdate(updateRequest{Name: *name, SourceFile: *updateSource, SHA256: *updateHash, Size: *updateSize})
		if err != nil {
			return err
		}
		return writeJSON(result)
	case "secure-runtime-pipe":
		if *runtimePID == 0 || *runtimePID > uint64(^uint32(0)) {
			return errors.New("invalid runtime server PID")
		}
		if err := secureRuntimePipe(*runtimePipe, uint32(*runtimePID)); err != nil {
			return err
		}
		return writeJSON(map[string]any{"secured": true, "serverPid": *runtimePID})
	case "validate-install":
		c := config{Version: 1, ServiceName: *name, InstallDir: *installDir, RuntimePath: *runtimePath}
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		if !samePath(exe, filepath.Join(c.InstallDir, hostFile)) {
			return errors.New("validation helper is not the installed host within installDir")
		}
		if err := c.validateInstall(); err != nil {
			return err
		}
		return writeJSON(map[string]any{"valid": true, "installDir": c.InstallDir, "runtimeRelativePath": c.RuntimePath})
	case "install":
		c := config{Version: 1, ServiceName: *name, InstallDir: *installDir, RuntimePath: *runtimePath}
		if *allowed != "" {
			c.AllowedSIDs = strings.Split(*allowed, ",")
		}
		return install(c)
	case "uninstall", "start", "stop", "status":
		return serviceCommand(args[0], *name)
	case "service":
		isService, err := svc.IsWindowsService()
		if err != nil {
			return err
		}
		if !isService {
			return errors.New("service command must be launched by Windows SCM; use console for authorized QA")
		}
		return svc.Run(*name, serviceHandler{*name})
	case "console":
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
		defer cancel()
		return runHost(ctx, *name, make(chan struct{}))
	case "broker-client":
		if *stdio {
			if *operation != "identity" || *target != "" || *sessionText != "" {
				return errors.New("--stdio cannot be combined with selector flags")
			}
			if err := privateStandardPipes(windows.Handle(os.Stdin.Fd()), windows.Handle(os.Stdout.Fd())); err != nil {
				return err
			}
			raw, err := bufio.NewReaderSize(os.Stdin, nativeFrameLimit).ReadSlice('\n')
			defer clear(raw)
			if err != nil {
				return errors.New("stdin must contain one bounded newline-terminated JSON request")
			}
			req, err := decodeRequest(raw)
			defer clearRequestSecrets(&req)
			if err != nil {
				return err
			}
			return brokerClient(*name, req, true)
		}
		req := request{Version: 1, Operation: *operation, Target: *target}
		if nativePasswordOperation(req.Operation) {
			return errors.New("ERR_NATIVE_PASSWORD_PRIVATE_CHANNEL_REQUIRED")
		}
		if *sessionText != "" {
			var err error
			req.SessionID, err = parseSessionID(*sessionText)
			if err != nil {
				return err
			}
		}
		raw, err := json.Marshal(req)
		if err != nil {
			return err
		}
		if _, err := decodeRequest(raw); err != nil {
			return err
		}
		return brokerClient(*name, req, false)
	default:
		return errors.New("unknown command")
	}
}

func install(c config) (err error) {
	if !windows.GetCurrentProcessToken().IsElevated() {
		return errors.New("installation requires an elevated administrator")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if !samePath(exe, filepath.Join(c.InstallDir, hostFile)) {
		return errors.New("run the protected installed anubis-host.exe, not a user-writable staging copy")
	}
	if err := c.validateInstall(); err != nil {
		return err
	}
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	existing, err := manager.OpenService(c.ServiceName)
	if err == nil {
		existing.Close()
		return errors.New("service already exists; configuration is never silently overwritten")
	}
	if !errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return err
	}
	root, err := dataDir(c.ServiceName)
	if err != nil {
		return err
	}
	for _, dir := range []string{filepath.Dir(filepath.Dir(root)), filepath.Dir(root), root} {
		if err := secureMkdir(dir); err != nil {
			return err
		}
	}
	if err := c.validate(); err != nil {
		return err
	}
	path, err := configPath(c.ServiceName)
	if err != nil {
		return err
	}
	newConfig := false
	serviceCreated := false
	defer func() {
		if err != nil && newConfig && !serviceCreated {
			err = errors.Join(err, os.Remove(path))
		}
	}()
	if _, statErr := os.Lstat(path); statErr == nil {
		existing, err := loadConfig(c.ServiceName)
		if err != nil {
			return err
		}
		if existing.Version != c.Version || existing.ServiceName != c.ServiceName ||
			!samePath(existing.InstallDir, c.InstallDir) || existing.RuntimePath != c.RuntimePath ||
			!slices.Equal(existing.AllowedSIDs, c.AllowedSIDs) {
			return errors.New("retained config differs; no silent overwrite is permitted")
		}
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	} else {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		newConfig = true
		writeErr := json.NewEncoder(f).Encode(c)
		syncErr := f.Sync()
		closeErr := f.Close()
		if err := errors.Join(writeErr, syncErr, closeErr); err != nil {
			return err
		}
		admins, err := windows.StringToSid("S-1-5-32-544")
		if err != nil {
			return err
		}
		if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION, admins, nil, nil, nil); err != nil {
			return err
		}
		if err := privatePath(path); err != nil {
			return err
		}
	}
	service, err := manager.CreateService(c.ServiceName, exe, mgr.Config{
		DisplayName: c.ServiceName, Description: "Anubis protected headless machine host; GUI runs separately.",
		StartType: mgr.StartAutomatic, ErrorControl: mgr.ErrorNormal, ServiceStartName: "LocalSystem",
	}, "service", "--name", c.ServiceName)
	if err != nil {
		return err
	}
	serviceCreated = true
	defer service.Close()
	if err := service.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 60 * time.Second},
	}, 86400); err != nil {
		deleteErr := service.Delete()
		serviceCreated = deleteErr != nil
		return errors.Join(err, deleteErr)
	}
	if err := service.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		deleteErr := service.Delete()
		serviceCreated = deleteErr != nil
		return errors.Join(err, deleteErr)
	}
	return writeJSON(map[string]any{"installed": true, "started": false, "name": c.ServiceName, "configPath": path})
}

func serviceCommand(operation, name string) error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(name)
	if err != nil {
		return err
	}
	defer service.Close()
	if operation == "status" {
		state, err := service.Query()
		if err != nil {
			return err
		}
		sc, err := service.Config()
		if err != nil {
			return err
		}
		return writeJSON(map[string]any{"name": name, "scm": state, "account": sc.ServiceStartName,
			"imagePath": sc.BinaryPathName, "automatic": sc.StartType == mgr.StartAutomatic})
	}
	c, err := loadConfig(name)
	if err != nil {
		return err
	}
	sc, err := service.Config()
	if err != nil {
		return err
	}
	want := windows.ComposeCommandLine([]string{filepath.Join(c.InstallDir, hostFile), "service", "--name", name})
	if sc.BinaryPathName != want || (sc.ServiceStartName != "LocalSystem" && sc.ServiceStartName != "") {
		return errors.New("refusing to modify a service with a different image/account")
	}
	switch operation {
	case "start":
		return service.Start()
	case "stop":
		_, err := service.Control(svc.Stop)
		return err
	case "uninstall":
		state, err := service.Query()
		if err != nil {
			return err
		}
		if state.State != svc.Stopped {
			return errors.New("stop service and wait for SCM Stopped before uninstalling")
		}
		if err := service.Delete(); err != nil {
			return err
		}
		return writeJSON(map[string]any{"uninstalled": true, "dataRetained": true})
	}
	return errors.New("unsupported service operation")
}

func brokerClient(name string, req request, private bool) error {
	if nativePasswordOperation(req.Operation) && !private {
		return errors.New("ERR_NATIVE_PASSWORD_PRIVATE_CHANNEL_REQUIRED")
	}
	path, err := pipePath(name)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	conn, err := winio.DialPipeAccessImpLevel(ctx, path, windows.GENERIC_READ|windows.GENERIC_WRITE, winio.PipeImpLevelIdentification)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err := verifyBrokerServer(name, conn); err != nil {
		return err
	}
	if err := conn.SetDeadline(time.Now().Add(40 * time.Second)); err != nil {
		return err
	}
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return err
	}
	raw, err := bufio.NewReaderSize(conn, nativeFrameLimit).ReadSlice('\n')
	defer clear(raw)
	if err != nil {
		return err
	}
	// Ordinary CLI output is not a credential channel; only the explicit private bridge carries proof.
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		return err
	}
	if info, ok := result["result"].(map[string]any); ok && !private {
		if endpoint, ok := info["endpoint"].(map[string]any); ok {
			delete(endpoint, "privateProof")
			endpoint["proofRedacted"] = true
		}
	}
	if err := writeJSON(result); err != nil {
		return err
	}
	if result["ok"] != true {
		return errors.New("broker request failed (see JSON error)")
	}
	return nil
}

func verifyBrokerServer(name string, conn net.Conn) error {
	fd, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return errors.New("broker pipe has no native handle")
	}
	var pid uint32
	if err := windows.GetNamedPipeServerProcessId(windows.Handle(fd.Fd()), &pid); err != nil {
		return err
	}
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(name)
	if err != nil {
		return err
	}
	defer service.Close()
	state, err := service.Query()
	if err != nil {
		return err
	}
	if state.State != svc.Running || state.ProcessId == 0 || state.ProcessId != pid {
		return errors.New("broker server is not the running SCM service process")
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	var token windows.Token
	if err := windows.OpenProcessToken(handle, windows.TOKEN_QUERY, &token); err != nil {
		return err
	}
	i, err := tokenIdentity(token, pid)
	token.Close()
	if err != nil {
		return err
	}
	if i.SID != "S-1-5-18" || i.SessionID != 0 {
		return errors.New("broker server is not actual LocalSystem session 0")
	}
	c, err := loadConfig(name)
	if err != nil {
		return err
	}
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil {
		return err
	}
	if !samePath(windows.UTF16ToString(buffer[:size]), filepath.Join(c.InstallDir, hostFile)) {
		return errors.New("broker image does not match protected installed host")
	}
	return nil
}
