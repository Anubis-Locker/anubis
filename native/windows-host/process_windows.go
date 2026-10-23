package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

const (
	readyTimeout = 30 * time.Second
	stopTimeout  = 15 * time.Second
)

type childInfo struct {
	ContextID   string           `json:"contextId"`
	ControlPipe string           `json:"controlPipe"`
	DataDir     string           `json:"dataDir"`
	Identity    identity         `json:"identity"`
	Endpoint    *runtimeEndpoint `json:"endpoint,omitempty"`
}

type runtimeEndpoint struct {
	LocalPort    uint16 `json:"localPort"`
	PrivateProof string `json:"privateProof"`
}

type child struct {
	Info      childInfo
	process   windows.Handle
	job       windows.Handle
	stopFile  string
	readyFile string
	exit      chan struct{}
	exitCode  uint32
	waitErr   error
	closeOnce sync.Once
	errorFile string
	logonSID  string
}

func randomID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func enablePrivilege(name string) error {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &token); err != nil {
		return err
	}
	defer token.Close()
	p, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, p, &luid); err != nil {
		return err
	}
	state := windows.Tokenprivileges{PrivilegeCount: 1}
	state.Privileges[0] = windows.LUIDAndAttributes{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}
	proc := windows.NewLazySystemDLL("advapi32.dll").NewProc("AdjustTokenPrivileges")
	ok, _, callErr := proc.Call(uintptr(token), 0, uintptr(unsafe.Pointer(&state)), 0, 0, 0)
	if ok == 0 || callErr == windows.ERROR_NOT_ALL_ASSIGNED {
		err := callErr
		return fmt.Errorf("enable %s: %w", name, err)
	}
	return nil
}

// Privileges are enabled only on the service token, never on a broker caller token.
func preparePrivileges() error {
	for _, name := range []string{"SeTcbPrivilege", "SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege"} {
		if err := enablePrivilege(name); err != nil {
			return err
		}
	}
	return nil
}

func primaryToken(sessionID *uint32, allowed []string) (windows.Token, identity, error) {
	var source windows.Token
	var err error
	if sessionID == nil {
		err = windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY, &source)
	} else {
		err = windows.WTSQueryUserToken(*sessionID, &source)
	}
	if err != nil {
		return 0, identity{}, err
	}
	defer source.Close()
	i, err := tokenIdentity(source, 0)
	if err != nil {
		return 0, i, err
	}
	if sessionID == nil {
		if i.SID != "S-1-5-18" || i.SessionID != 0 {
			return 0, i, errors.New("SYSTEM target requires LocalSystem session 0 token")
		}
	} else {
		if *sessionID == 0 || i.SessionID != *sessionID {
			return 0, i, errors.New("user session/token mismatch")
		}
		authorized := false
		for _, sid := range allowed {
			authorized = authorized || i.SID == sid
		}
		if !authorized {
			return 0, i, errors.New("logged-on account SID is not explicitly authorized in machine config")
		}
	}
	var primary windows.Token
	err = windows.DuplicateTokenEx(source, windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE|windows.TOKEN_ASSIGN_PRIMARY|
		windows.TOKEN_ADJUST_DEFAULT|windows.TOKEN_ADJUST_SESSIONID, nil, windows.SecurityImpersonation, windows.TokenPrimary, &primary)
	return primary, i, err
}

func (c config) launch(ctx context.Context, machine bool, sessionID *uint32) (*child, error) {
	if machine != (sessionID == nil) {
		return nil, errors.New("only the canonical machine engine may use SYSTEM; user contexts require a logged-on session")
	}
	token, expected, err := primaryToken(sessionID, c.AllowedSIDs)
	if err != nil {
		return nil, err
	}
	defer token.Close()
	return c.launchToken(ctx, machine, token, expected)
}

func (c config) launchToken(ctx context.Context, machine bool, token windows.Token, expected identity) (*child, error) {
	if machine != (expected.SID == "S-1-5-18" && expected.SessionID == 0) {
		return nil, errors.New("launch token does not match machine/user role")
	}
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	root, err := dataDir(c.ServiceName)
	if err != nil {
		return nil, err
	}
	parent := filepath.Join(root, "runs")
	if err := secureMkdir(parent); err != nil {
		return nil, err
	}
	parent = filepath.Join(parent, expected.SID)
	if err := secureMkdir(parent); err != nil {
		return nil, err
	}
	dir := filepath.Join(parent, id)
	if err := secureMkdir(dir); err != nil {
		return nil, err
	}
	if !machine {
		if err := applyACL(dir, adminSDDL+"(A;OICI;GRGX;;;"+expected.SID+")"); err != nil {
			return nil, err
		}
	}
	stateDir := filepath.Join(dir, "data")
	if err := secureMkdir(stateDir); err != nil {
		return nil, err
	}
	if !machine {
		if err := applyACL(stateDir, adminSDDL+"(A;OICI;FA;;;"+expected.SID+")"); err != nil {
			return nil, err
		}
	}
	ch := &child{
		Info:     childInfo{ContextID: id, ControlPipe: `\\.\pipe\` + c.ServiceName + "-context-" + id, DataDir: stateDir},
		stopFile: filepath.Join(dir, "stop.request"), readyFile: filepath.Join(dir, "ready.json"),
		errorFile: filepath.Join(dir, "error.json"),
	}
	// Only this precreated file is writable by the worker, not its parent directory.
	// That prevents a user worker from redirecting SYSTEM readiness/stop I/O via a junction.
	for _, path := range []string{ch.readyFile, ch.errorFile} {
		if err := os.WriteFile(path, nil, 0600); err != nil {
			return nil, err
		}
		if !machine {
			if err := applyACL(path, adminSDDL+"(A;;GRGW;;;"+expected.SID+")"); err != nil {
				return nil, err
			}
		}
	}
	if machine {
		stateDir = filepath.Join(root, "system-profile")
		if err := secureMkdir(stateDir); err != nil {
			return nil, err
		}
		ch.Info.DataDir = stateDir
	}
	groups, err := token.GetTokenGroups()
	if err != nil {
		return nil, err
	}
	for _, group := range groups.AllGroups() {
		if group.Attributes&windows.SE_GROUP_LOGON_ID == windows.SE_GROUP_LOGON_ID {
			ch.logonSID = group.Sid.String()
		}
	}
	mode := "--anubis-context-worker"
	if machine {
		mode = "--anubis-machine-host"
	}
	args := []string{mode, "--anubis-data-dir", stateDir, "--anubis-context-id", id,
		"--anubis-ready-file", ch.readyFile, "--anubis-stop-file", ch.stopFile,
		"--anubis-error-file", ch.errorFile,
		"--anubis-control-pipe", ch.Info.ControlPipe}
	exe := filepath.Join(c.InstallDir, c.RuntimePath)
	if err := ch.start(token, exe, args, c.InstallDir); err != nil {
		return nil, err
	}
	if ch.Info.Identity.SID != expected.SID || ch.Info.Identity.SessionID != expected.SessionID {
		ch.close()
		return nil, errors.New("created process token identity differs from requested target")
	}
	if err := ch.awaitReady(ctx); err != nil {
		ch.close()
		return nil, err
	}
	if err := ch.describe(ctx); err != nil {
		ch.close()
		return nil, err
	}
	select {
	case <-ch.exit:
		ch.close()
		return nil, errors.New("runtime exited during control endpoint validation")
	default:
	}
	return ch, nil
}

func (c *child) start(token windows.Token, exe string, args []string, cwd string) (err error) {
	c.job, err = windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			c.close()
		}
	}()
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err = windows.SetInformationJobObject(c.job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return err
	}
	application, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		return err
	}
	command, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(append([]string{exe}, args...)))
	if err != nil {
		return err
	}
	directory, err := windows.UTF16PtrFromString(cwd)
	if err != nil {
		return err
	}
	var environment *uint16
	if err = windows.CreateEnvironmentBlock(&environment, token, false); err != nil {
		return fmt.Errorf("CreateEnvironmentBlock: %w", err)
	}
	defer windows.DestroyEnvironmentBlock(environment)
	startup := windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{}))}
	var proc windows.ProcessInformation
	if err = windows.CreateProcessAsUser(token, application, command, nil, nil, false,
		windows.CREATE_SUSPENDED|windows.CREATE_UNICODE_ENVIRONMENT|windows.CREATE_NO_WINDOW,
		environment, directory, &startup, &proc); err != nil {
		return fmt.Errorf("CreateProcessAsUser: %w", err)
	}
	c.process = proc.Process
	defer windows.CloseHandle(proc.Thread)
	if err = windows.AssignProcessToJobObject(c.job, proc.Process); err != nil {
		return errors.Join(fmt.Errorf("AssignProcessToJobObject: %w", err), windows.TerminateProcess(proc.Process, 1))
	}
	var actual windows.Token
	if err = windows.OpenProcessToken(proc.Process, windows.TOKEN_QUERY, &actual); err != nil {
		return err
	}
	c.Info.Identity, err = tokenIdentity(actual, proc.ProcessId)
	actual.Close()
	if err != nil {
		return err
	}
	if _, err = windows.ResumeThread(proc.Thread); err != nil {
		return err
	}
	c.exit = make(chan struct{})
	go func() {
		_, c.waitErr = windows.WaitForSingleObject(c.process, windows.INFINITE)
		if c.waitErr == nil {
			c.waitErr = windows.GetExitCodeProcess(c.process, &c.exitCode)
		}
		close(c.exit)
	}()
	return nil
}

func validReady(raw []byte, info *childInfo) error {
	var ready struct {
		Version   int    `json:"version"`
		PID       uint32 `json:"pid"`
		ContextID string `json:"contextId"`
	}
	if err := json.Unmarshal(raw, &ready); err != nil {
		return err
	}
	if ready.Version != 1 || ready.PID != info.Identity.PID || ready.ContextID != info.ContextID {
		return errors.New("runtime readiness PID/context/version mismatch")
	}
	return nil
}

func (c *child) awaitReady(ctx context.Context) error {
	timer := time.NewTimer(readyTimeout)
	defer timer.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	var lastErr error
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.exit:
			if err := c.startupError(); err != nil {
				return err
			}
			return fmt.Errorf("runtime exited before readiness: code %d, wait error %v", c.exitCode, c.waitErr)
		case <-timer.C:
			return fmt.Errorf("runtime readiness timed out after 30s (last readiness error: %v)", lastErr)
		case <-tick.C:
			if err := c.startupError(); err != nil {
				return err
			}
			raw, readErr := readControlFile(c.readyFile)
			if readErr != nil {
				lastErr = errors.New("readiness document is empty or unreadable")
				continue
			}
			if err := validReady(raw, &c.Info); err != nil {
				// The precreated readiness file is updated in place, not by rename.
				lastErr = errors.New("readiness document is incomplete or has invalid identity/endpoint")
				continue
			}
			select {
			case <-c.exit:
				return errors.New("runtime exited during readiness")
			default:
				return nil
			}
		}
	}
}

func readControlFile(path string) ([]byte, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	defer windows.CloseHandle(h)
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return nil, err
	}
	if info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 ||
		info.FileSizeHigh != 0 || info.FileSizeLow > 4096 {
		return nil, errors.New("invalid control file type/size")
	}
	raw := make([]byte, 4096)
	var n uint32
	if err := windows.ReadFile(h, raw, &n, nil); err != nil {
		return nil, err
	}
	return raw[:n], nil
}

func (c *child) startupError() error {
	raw, err := readControlFile(c.errorFile)
	if err != nil {
		return err
	}
	if len(raw) == 0 {
		return nil
	}
	var document struct {
		Version   int    `json:"version"`
		PID       uint32 `json:"pid"`
		ContextID string `json:"contextId"`
		Phase     string `json:"phase"`
		Code      string `json:"code"`
	}
	if json.Unmarshal(raw, &document) != nil {
		return nil // In-place write is not complete yet.
	}
	if document.Version != 1 || document.PID != c.Info.Identity.PID || document.ContextID != c.Info.ContextID {
		return errors.New("runtime startup error document identity mismatch")
	}
	phases := map[string]bool{"bootstrap": true, "engine": true, "control": true, "shutdown": true}
	if !phases[document.Phase] || !regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`).MatchString(document.Code) {
		return errors.New("runtime supplied invalid sanitized startup error")
	}
	return fmt.Errorf("runtime startup failed: phase=%s code=%s", document.Phase, document.Code)
}

func (c *child) describe(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	// Anonymous SQOS: even a user-owned worker cannot impersonate the SYSTEM host.
	conn, err := winio.DialPipeContext(ctx, c.Info.ControlPipe)
	if err != nil {
		return fmt.Errorf("runtime control pipe unavailable: %w", err)
	}
	defer conn.Close()
	fd, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return errors.New("runtime control pipe has no native handle")
	}
	h := windows.Handle(fd.Fd())
	var pid uint32
	if err := windows.GetNamedPipeServerProcessId(h, &pid); err != nil {
		return err
	}
	if pid != c.Info.Identity.PID {
		return errors.New("runtime control pipe server PID does not match owned process")
	}
	if err := c.validatePipeACL(h); err != nil {
		return err
	}
	if err := conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	if err := json.NewEncoder(conn).Encode(map[string]any{"version": 1, "operation": "describe"}); err != nil {
		return err
	}
	raw, err := bufio.NewReaderSize(conn, 8192).ReadSlice('\n')
	if err != nil {
		return errors.New("runtime describe reply missing or oversized")
	}
	var reply struct {
		Version int  `json:"version"`
		OK      bool `json:"ok"`
		Result  struct {
			PID       uint32           `json:"pid"`
			ContextID string           `json:"contextId"`
			Endpoint  *runtimeEndpoint `json:"endpoint"`
		} `json:"result"`
	}
	if json.Unmarshal(raw, &reply) != nil || reply.Version != 1 || !reply.OK ||
		reply.Result.PID != c.Info.Identity.PID || reply.Result.ContextID != c.Info.ContextID {
		return errors.New("runtime describe reply has invalid process/context identity")
	}
	endpoint := reply.Result.Endpoint
	if endpoint == nil || endpoint.LocalPort == 0 || len(endpoint.PrivateProof) < 32 || len(endpoint.PrivateProof) > 512 {
		return errors.New("runtime describe reply has invalid private loopback endpoint")
	}
	c.Info.Endpoint = endpoint
	return nil
}

func (c *child) validatePipeACL(h windows.Handle) error {
	sd, err := windows.GetSecurityInfo(h, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if acl == nil {
		return errors.New("runtime control pipe has null DACL")
	}
	networkDenied := false
	allowSeen := false
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, index, &ace); err != nil {
			return err
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
			const fileAllAccess = 0x001f01ff
			if sid != "S-1-5-2" || (ace.Mask&windows.GENERIC_ALL == 0 &&
				ace.Mask&fileAllAccess != fileAllAccess) ||
				ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
				return errors.New("runtime control pipe has unexpected deny ACE")
			}
			if allowSeen {
				return errors.New("runtime control pipe network deny must precede allow ACEs")
			}
			networkDenied = true
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return errors.New("runtime control pipe uses unsupported ACL")
		}
		allowSeen = true
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		if ace.Mask != 0 && sid != "S-1-5-18" && sid != "S-1-5-32-544" &&
			sid != c.Info.Identity.SID && (c.logonSID == "" || sid != c.logonSID) {
			return errors.New("runtime control pipe permits unrelated principals")
		}
	}
	if !networkDenied {
		return errors.New("runtime control pipe does not deny network logon")
	}
	return nil
}

func (c *child) stop() error {
	select {
	case <-c.exit:
		c.close()
		return c.waitErr
	default:
	}
	err := os.WriteFile(c.stopFile, []byte("stop\n"), 0600)
	timer := time.NewTimer(stopTimeout)
	defer timer.Stop()
	select {
	case <-c.exit:
		if c.waitErr != nil {
			err = errors.Join(err, c.waitErr)
		}
	case <-timer.C:
		err = errors.Join(err, errors.New("runtime exceeded 15s stop deadline; terminating owned job"))
	}
	c.close()
	return err
}

func (c *child) close() {
	c.closeOnce.Do(func() {
		if c.job != 0 {
			windows.CloseHandle(c.job)
		}
		if c.exit != nil {
			<-c.exit
		}
		if c.process != 0 {
			windows.CloseHandle(c.process)
		}
	})
}

func parseSessionID(text string) (*uint32, error) {
	n, err := strconv.ParseUint(text, 10, 32)
	if err != nil || n == 0 {
		return nil, errors.New("session ID must be an explicit nonzero uint32")
	}
	id := uint32(n)
	return &id, nil
}
