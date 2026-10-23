package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func TestBrokerRequestValidation(t *testing.T) {
	valid := []string{
		`{"version":1,"operation":"identity"}`,
		`{"version":1,"operation":"list-sessions"}`,
		`{"version":1,"operation":"launch-context","target":"system"}`,
		`{"version":1,"operation":"launch-context","target":"user","sessionId":2}`,
	}
	for _, raw := range valid {
		if _, err := decodeRequest([]byte(raw)); err != nil {
			t.Errorf("%s: %v", raw, err)
		}
	}
	invalid := []string{
		`{}`, `[]`, `{"version":2,"operation":"identity"}`,
		`{"version":1,"operation":"exec","path":"cmd.exe"}`,
		`{"version":1,"operation":"identity","argv":["evil"]}`,
		`{"version":1,"operation":"identity","target":"system"}`,
		`{"version":1,"operation":"launch-context","target":"user"}`,
		`{"version":1,"operation":"launch-context","target":"user","sessionId":0}`,
		`{"version":1,"operation":"launch-context","target":"user","sessionId":-1}`,
		`{"version":1,"operation":"launch-context","target":"system","sessionId":2}`,
		`{"version":1,"operation":"launch-context","target":"admin"}`,
		`{"version":1,"operation":"identity"} {}`,
	}
	for _, raw := range invalid {
		if _, err := decodeRequest([]byte(raw)); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}

func TestNamedPipeBrokerAuthenticationAndLimits(t *testing.T) {
	id, err := randomID()
	if err != nil {
		t.Fatal(err)
	}

	name := "AnubisHost-QA-" + id
	listener, err := listenBroker(name)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	b := &broker{logger: log.New(os.Stderr, "QA broker: ", 0)}
	go func() { done <- b.serve(ctx, listener) }()
	defer func() {
		cancel()
		listener.Close()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("broker cancellation did not join blocked clients")
		}
	}()
	path, _ := pipePath(name)
	call := func(raw string, level winio.PipeImpLevel) response {
		t.Helper()
		callCtx, callCancel := context.WithTimeout(ctx, 3*time.Second)
		defer callCancel()
		conn, err := winio.DialPipeAccessImpLevel(callCtx, path, windows.GENERIC_READ|windows.GENERIC_WRITE, level)
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(3 * time.Second))
		if _, err := io.WriteString(conn, raw+"\n"); err != nil {
			t.Fatal(err)
		}
		var reply response
		if err := json.NewDecoder(conn).Decode(&reply); err != nil {
			t.Fatal(err)
		}
		return reply
	}
	if reply := call(`{"version":1,"operation":"identity"}`, winio.PipeImpLevelIdentification); !reply.OK {
		t.Fatalf("real elevated caller denied: %+v", reply)
	}
	if reply := call(`{"version":1,"operation":"identity"}`, winio.PipeImpLevelAnonymous); reply.OK {
		t.Fatal("anonymous SQOS accepted by authenticated broker")
	}
	if reply := call(`{"version":1,"operation":"identity","executable":"cmd.exe"}`, winio.PipeImpLevelIdentification); reply.OK {
		t.Fatal("arbitrary executable field accepted")
	}
	if reply := call(`{"version":1,"operation":"launch-context","target":"system"}`, winio.PipeImpLevelIdentification); reply.OK {
		t.Fatal("missing machine silently fell back to another engine")
	}
	conn, err := winio.DialPipeAccessImpLevel(ctx, path, windows.GENERIC_READ|windows.GENERIC_WRITE, winio.PipeImpLevelIdentification)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := io.WriteString(conn, strings.Repeat("x", 8193)); err != nil {
		t.Fatal(err)
	}
	if _, err := bufio.NewReader(conn).ReadByte(); err == nil {
		t.Fatal("oversized request was not disconnected")
	}
	// Cancellation must also close a client that has never sent a request.
	idle, err := winio.DialPipeAccessImpLevel(ctx, path, windows.GENERIC_READ|windows.GENERIC_WRITE, winio.PipeImpLevelIdentification)
	if err != nil {
		t.Fatal(err)
	}
	defer idle.Close()
}

func restrictedAdminToken(t *testing.T) windows.Token {
	t.Helper()
	admins, err := windows.StringToSid("S-1-5-32-544")
	if err != nil {
		t.Fatal(err)
	}
	disabled := windows.SIDAndAttributes{Sid: admins}
	var restricted windows.Token
	proc := windows.NewLazySystemDLL("advapi32.dll").NewProc("CreateRestrictedToken")
	ok, _, callErr := proc.Call(uintptr(currentPrimary(t)), 1, 1, uintptr(unsafe.Pointer(&disabled)),
		0, 0, 0, 0, uintptr(unsafe.Pointer(&restricted)))
	if ok == 0 {
		t.Fatal(callErr)
	}
	defer restricted.Close()
	var impersonation windows.Token
	if err := windows.DuplicateTokenEx(restricted, windows.TOKEN_QUERY|windows.TOKEN_IMPERSONATE,
		nil, windows.SecurityImpersonation, windows.TokenImpersonation, &impersonation); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { impersonation.Close() })
	return impersonation
}

func TestBrokerPipeDeniesRestrictedAdministrator(t *testing.T) {
	id, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	name := "AnubisHost-QA-" + id
	listener, err := listenBroker(name)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	impersonation := restrictedAdminToken(t)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := windows.SetThreadToken(nil, impersonation); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := windows.RevertToSelf(); err != nil {
			panic("QA RevertToSelf failed")
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	path, _ := pipePath(name)
	conn, err := winio.DialPipeAccessImpLevel(ctx, path, windows.GENERIC_READ|windows.GENERIC_WRITE, winio.PipeImpLevelIdentification)
	if err == nil {
		conn.Close()
		t.Fatal("restricted administrator opened the SYSTEM/Administrators broker")
	}
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("expected kernel ACL denial, got %v", err)
	}
}
