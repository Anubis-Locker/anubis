package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func TestReadyIdentityBinding(t *testing.T) {
	info := childInfo{ContextID: "qa-context", Identity: identity{PID: 123}}
	for _, raw := range []string{
		`{"version":1,"pid":124,"contextId":"qa-context"}`,
		`{"version":1,"pid":123,"contextId":"other"}`,
		`{"version":2,"pid":123,"contextId":"qa-context"}`,
		`{"version":1,"pid":123}`,
	} {
		if err := validReady([]byte(raw), &info); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	if err := validReady([]byte(`{"version":1,"pid":123,"contextId":"qa-context"}`), &info); err != nil {
		t.Fatal(err)
	}
}

func currentPrimary(t *testing.T) windows.Token {
	t.Helper()
	var source windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY, &source); err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	var token windows.Token
	err := windows.DuplicateTokenEx(source,
		windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE|windows.TOKEN_ASSIGN_PRIMARY,
		nil, windows.SecurityImpersonation, windows.TokenPrimary, &token)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { token.Close() })
	return token
}

func qaChild(t *testing.T, mode string) *child {
	t.Helper()
	dir := t.TempDir()
	id, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ch := &child{
		Info:      childInfo{ContextID: id, ControlPipe: `\\.\pipe\AnubisHost-QA-` + id},
		readyFile: filepath.Join(dir, "ready.json"), errorFile: filepath.Join(dir, "error.json"),
		stopFile: filepath.Join(dir, "stop.request"),
	}
	for _, path := range []string{ch.readyFile, ch.errorFile} {
		if err := os.WriteFile(path, nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	args := []string{"-test.run=^TestChildHelper$", "--", "anubis-qa-helper", mode, dir, id, ch.Info.ControlPipe}
	if err := ch.start(currentPrimary(t), exe, args, dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(ch.close)
	return ch
}

func TestActualProcessReadinessIdentityDescribeAndGracefulStop(t *testing.T) {
	ch := qaChild(t, "ready")
	actual, err := currentIdentity()
	if err != nil {
		t.Fatal(err)
	}
	if ch.Info.Identity.PID == 0 || ch.Info.Identity.PID == actual.PID ||
		ch.Info.Identity.SID != actual.SID || ch.Info.Identity.SessionID != actual.SessionID {
		t.Fatalf("wrong created process identity: %+v", ch.Info.Identity)
	}
	if err := ch.awaitReady(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := ch.describe(context.Background()); err != nil {
		t.Fatal(err)
	}
	if ch.Info.Endpoint == nil || ch.Info.Endpoint.LocalPort != 12345 {
		t.Fatal("describe endpoint was not captured")
	}
	if err := ch.stop(); err != nil {
		t.Fatal(err)
	}
	if ch.exitCode != 0 {
		t.Fatalf("graceful stop returned code %d", ch.exitCode)
	}
}

func TestRuntimeRejectsBroadPipeACL(t *testing.T) {
	ch := qaChild(t, "broad-pipe")
	if err := ch.awaitReady(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := ch.describe(context.Background()); err == nil || !strings.Contains(err.Error(), "unrelated principals") {
		t.Fatalf("broad runtime pipe ACL was not rejected: %v", err)
	}
}

func TestJobClosureTerminatesOwnedGrandchild(t *testing.T) {
	ch := qaChild(t, "grandchild")
	pidFile := filepath.Join(filepath.Dir(ch.readyFile), "grandchild.pid")
	var raw []byte
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		raw, _ = os.ReadFile(pidFile)
		if len(raw) != 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	pid, err := strconv.ParseUint(string(raw), 10, 32)
	if err != nil {
		t.Fatalf("grandchild did not report PID: %v", err)
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	ch.close()
	result, err := windows.WaitForSingleObject(handle, 3000)
	if err != nil || result != windows.WAIT_OBJECT_0 {
		t.Fatalf("owned grandchild survived job closure: result=%d error=%v", result, err)
	}
}

func TestStartupFailureRetainsSanitizedPhase(t *testing.T) {
	ch := qaChild(t, "error")
	err := ch.awaitReady(context.Background())
	if err == nil || !strings.Contains(err.Error(), "phase=engine code=QA_ENGINE_FAILED") || strings.Contains(err.Error(), "do-not-log") {
		t.Fatalf("expected sanitized real startup evidence, got %v", err)
	}
}

func TestControlFileRejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "private.json")
	if err := os.WriteFile(target, []byte(`{"privateProof":"do-not-read"}`), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "ready.json")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if raw, err := readControlFile(link); err == nil || len(raw) != 0 {
		t.Fatal("SYSTEM control file reader followed a reparse point")
	}
}

// This subprocess is launched only by tests, never by the installed executable.
func TestChildHelper(t *testing.T) {
	marker := -1
	for index, arg := range os.Args {
		if arg == "anubis-qa-helper" {
			marker = index
			break
		}
	}
	if marker < 0 {
		return
	}
	args := os.Args[marker+1:]
	mode, dir, id, pipe := args[0], args[1], args[2], args[3]
	if mode == "sleep" {
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	if mode == "grandchild" {
		cmd := exec.Command(os.Args[0], "-test.run=^TestChildHelper$", "--", "anubis-qa-helper", "sleep", dir, id, pipe)
		if err := cmd.Start(); err != nil {
			os.Exit(2)
		}
		if err := os.WriteFile(filepath.Join(dir, "grandchild.pid"), []byte(strconv.Itoa(cmd.Process.Pid)), 0600); err != nil {
			os.Exit(3)
		}
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	if mode == "error" {
		raw := fmt.Sprintf(`{"version":1,"pid":%d,"contextId":%q,"phase":"engine","code":"QA_ENGINE_FAILED","message":"do-not-log"}`, os.Getpid(), id)
		if err := os.WriteFile(filepath.Join(dir, "error.json"), []byte(raw), 0600); err != nil {
			os.Exit(4)
		}
		time.Sleep(time.Second)
		os.Exit(5)
	}
	i, err := currentIdentity()
	if err != nil {
		os.Exit(6)
	}
	sddl := "D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;" + i.SID + ")"
	if mode == "broad-pipe" {
		sddl = "D:P(A;;GA;;;WD)"
	}
	listener, err := winio.ListenPipe(pipe, &winio.PipeConfig{SecurityDescriptor: sddl})
	if err != nil {
		os.Exit(7)
	}
	defer listener.Close()
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(10 * time.Second))
		var req map[string]any
		if json.NewDecoder(conn).Decode(&req) != nil {
			return
		}
		json.NewEncoder(conn).Encode(map[string]any{
			"version": 1, "ok": true,
			"result": map[string]any{"pid": os.Getpid(), "contextId": id,
				"endpoint": runtimeEndpoint{LocalPort: 12345, PrivateProof: strings.Repeat("qa", 32)}},
		})
	}()
	raw := fmt.Sprintf(`{"version":1,"pid":%d,"contextId":%q}`, os.Getpid(), id)
	if err := os.WriteFile(filepath.Join(dir, "ready.json"), []byte(raw), 0600); err != nil {
		os.Exit(8)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "stop.request")); err == nil {
			os.Exit(0)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
