package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"runtime"
	"sync"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

type request struct {
	Version    int     `json:"version"`
	Operation  string  `json:"operation"`
	Target     string  `json:"target,omitempty"`
	SessionID  *uint32 `json:"sessionId,omitempty"`
	AccountSID string  `json:"accountSid,omitempty"`
	LogonSID   string  `json:"logonSid,omitempty"`
	ContextID  string  `json:"contextId,omitempty"`
}

type response struct {
	Version int    `json:"version"`
	OK      bool   `json:"ok"`
	Result  any    `json:"result,omitempty"`
	Error   string `json:"error,omitempty"`
}

type broker struct {
	config   config
	logger   *log.Logger
	mu       sync.Mutex
	machine  *child
	contexts map[string]*child
	stopping bool
	monitors sync.WaitGroup
}

func pipePath(name string) (string, error) {
	if !servicePattern.MatchString(name) {
		return "", errors.New("invalid service name")
	}
	return `\\.\pipe\` + name + "-broker-v1", nil
}

func authenticate(conn net.Conn) (identity, error) {
	f, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return identity{}, errors.New("named-pipe connection has no native handle")
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	proc := windows.NewLazySystemDLL("advapi32.dll").NewProc("ImpersonateNamedPipeClient")
	result, _, callErr := proc.Call(f.Fd())
	if result == 0 {
		return identity{}, fmt.Errorf("ImpersonateNamedPipeClient: %w", callErr)
	}
	impersonating := true
	defer func() {
		// Continuing with a client token would cross a security boundary.
		if impersonating {
			if err := windows.RevertToSelf(); err != nil {
				panic("RevertToSelf failed")
			}
		}
	}()
	var token windows.Token
	if err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY, true, &token); err != nil {
		return identity{}, err
	}
	defer token.Close()
	// Identification-level clients permit token inspection, not LSA/network access.
	// Retain the captured token, but resolve account names under the service identity.
	if err := windows.RevertToSelf(); err != nil {
		panic("RevertToSelf failed")
	}
	impersonating = false
	i, err := tokenIdentity(token, 0)
	if err != nil {
		return i, err
	}
	restricted, err := token.IsRestricted()
	if err != nil {
		return i, err
	}
	admins, err := windows.StringToSid("S-1-5-32-544")
	if err != nil {
		return i, err
	}
	member, err := token.IsMember(admins)
	if err != nil {
		return i, err
	}
	if restricted || (i.SID != "S-1-5-18" && (!member || !i.Elevated)) {
		return i, errors.New("broker requires LocalSystem or an elevated local administrator")
	}
	return i, nil
}

func decodeRequest(raw []byte) (request, error) {
	var req request
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return req, errors.New("invalid broker request JSON")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return req, errors.New("request must contain exactly one JSON object")
	}
	if req.Version != 1 {
		return req, errors.New("unsupported broker version")
	}
	switch req.Operation {
	case "identity", "list-sessions", "list-contexts":
		if req.Target != "" || req.SessionID != nil || req.AccountSID != "" || req.LogonSID != "" || req.ContextID != "" {
			return req, errors.New("unexpected target/sessionId")
		}
	case "launch-context", "resolve-context":
		if req.Target != "system" && req.Target != "user" {
			return req, errors.New("target must be system or user")
		}
		if (req.Target == "system" && req.SessionID != nil) ||
			(req.Target == "user" && (req.SessionID == nil || *req.SessionID == 0)) {
			return req, errors.New("user target requires a nonzero sessionId; system target forbids sessionId")
		}
		if req.Target == "system" && (req.AccountSID != "" || req.LogonSID != "") {
			return req, errors.New("SYSTEM target forbids user identity guards")
		}
		if req.AccountSID != "" || req.LogonSID != "" || req.Operation == "resolve-context" && req.Target == "user" {
			if !accountSIDPattern.MatchString(req.AccountSID) || !logonSIDPattern.MatchString(req.LogonSID) {
				return req, errors.New("user guard requires canonical accountSid and logonSid")
			}
		}
		if req.Operation == "resolve-context" {
			if !contextIDPattern.MatchString(req.ContextID) {
				return req, errors.New("resolve-context requires exact contextId")
			}
		} else if req.ContextID != "" {
			return req, errors.New("launch-context forbids contextId")
		}
	default:
		return req, errors.New("unsupported broker operation")
	}
	return req, nil
}

func (b *broker) dispatch(ctx context.Context, req request) (any, error) {
	switch req.Operation {
	case "identity":
		host, err := currentIdentity()
		if err != nil {
			return nil, err
		}
		b.mu.Lock()
		defer b.mu.Unlock()
		var machine *childInfo
		if b.machine != nil {
			select {
			case <-b.machine.exit:
			default:
				copy := b.machine.Info
				// Identity/status is never a credential transport.
				copy.Endpoint = nil
				machine = &copy
			}
		}
		return struct {
			Host    identity   `json:"host"`
			Machine *childInfo `json:"machine"`
		}{host, machine}, nil
	case "list-sessions":
		return sessions()
	case "list-contexts":
		return b.listContexts()
	case "launch-context", "resolve-context":
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.stopping {
			return nil, errors.New("service is stopping")
		}
		if req.Target == "system" {
			if b.machine == nil {
				return nil, errors.New("machine engine is recovering; no SYSTEM fallback")
			}
			select {
			case <-b.machine.exit:
				return nil, errors.New("machine engine exited; recovery in progress")
			default:
				if req.Operation == "resolve-context" {
					if req.ContextID != b.machine.Info.ContextID {
						return nil, errors.New("machine context was replaced")
					}
					if err := b.machine.describe(ctx); err != nil {
						return nil, err
					}
				}
				return b.machine.Info, nil
			}
		}
		policy, err := b.contextPolicy()
		if err != nil {
			return nil, err
		}
		token, expected, err := primaryToken(req.SessionID, policy.AllowedSIDs)
		if err != nil {
			return nil, err
		}
		defer token.Close()
		logon, err := logonSID(token)
		if err != nil || logon == "" {
			return nil, errors.Join(errors.New("logged-on user token has no logon SID"), err)
		}
		if req.AccountSID != "" && (req.AccountSID != expected.SID || req.LogonSID != logon) {
			return nil, errors.New("selected Windows account or logon session changed")
		}
		if req.Operation == "resolve-context" {
			ch, err := retainedContext(b.contexts, req.ContextID, expected, logon)
			if err != nil {
				return nil, err
			}
			if err := ch.describe(ctx); err != nil {
				return nil, err
			}
			return ch.Info, nil
		}
		for id, ch := range b.contexts {
			select {
			case <-ch.exit:
				ch.close()
				delete(b.contexts, id)
			default:
				if ch.Info.Identity.SessionID == expected.SessionID &&
					!matchingContext(ch, expected, logon) {
					delete(b.contexts, id)
					if err := ch.stop(); err != nil {
						return nil, fmt.Errorf("stop worker from previous Windows logon: %w", err)
					}
					continue
				}
				if matchingContext(ch, expected, logon) {
					return ch.Info, nil
				}
			}
		}
		if len(b.contexts) >= 8 {
			return nil, errors.New("maximum 8 live context workers reached")
		}
		ch, err := policy.launchToken(ctx, false, token, expected)
		if err != nil {
			return nil, err
		}
		b.contexts[ch.Info.ContextID] = ch
		b.monitors.Add(1)
		go func() {
			defer b.monitors.Done()
			<-ch.exit
			ch.close()
			b.mu.Lock()
			if b.contexts[ch.Info.ContextID] == ch {
				delete(b.contexts, ch.Info.ContextID)
			}
			b.mu.Unlock()
			b.logger.Printf("context exited context=%s pid=%d code=%d waitError=%v",
				ch.Info.ContextID, ch.Info.Identity.PID, ch.exitCode, ch.waitErr)
		}()
		b.logger.Printf("context ready context=%s pid=%d sid=%s session=%d", ch.Info.ContextID,
			ch.Info.Identity.PID, ch.Info.Identity.SID, ch.Info.Identity.SessionID)
		return ch.Info, nil
	default:
		return nil, errors.New("unsupported broker operation")
	}
}

func (b *broker) serve(ctx context.Context, listener net.Listener) error {
	ctx, cancel := context.WithCancel(ctx)
	var workers sync.WaitGroup
	slots := make(chan struct{}, 8)
	watcherDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			listener.Close()
		case <-watcherDone:
		}
	}()
	defer close(watcherDone)
	defer func() {
		cancel()
		listener.Close()
		workers.Wait()
	}()
	for {
		conn, err := listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		select {
		case slots <- struct{}{}:
		default:
			conn.Close()
			b.logger.Print("broker connection limit reached")
			continue
		}
		workers.Add(1)
		go func() {
			defer workers.Done()
			defer func() { <-slots }()
			defer conn.Close()
			connDone := make(chan struct{})
			defer close(connDone)
			go func() {
				select {
				case <-ctx.Done():
					conn.Close()
				case <-connDone:
				}
			}()
			if err := conn.SetDeadline(time.Now().Add(45 * time.Second)); err != nil {
				b.logger.Printf("broker deadline: %v", err)
				return
			}
			raw, err := bufio.NewReaderSize(conn, 8192).ReadSlice('\n')
			if err != nil {
				b.logger.Print("broker rejected incomplete or oversized request")
				return
			}
			caller, err := authenticate(conn)
			reply := response{Version: 1}
			if err != nil {
				reply.Error = "access denied: elevated local administrator required"
				b.logger.Printf("broker authentication denied: %v", err)
			} else {
				req, err := decodeRequest(raw)
				if err != nil {
					reply.Error = err.Error()
				} else {
					b.logger.Printf("broker caller=%s operation=%s", caller.SID, req.Operation)
					reply.Result, err = b.dispatch(ctx, req)
					if err != nil {
						reply.Error = err.Error()
					} else {
						reply.OK = true
					}
				}
			}
			if err := json.NewEncoder(conn).Encode(reply); err != nil {
				b.logger.Printf("broker reply write: %v", err)
			}
		}()
	}
}

func (b *broker) stopContexts() {
	b.mu.Lock()
	b.stopping = true
	children := make([]*child, 0, len(b.contexts))
	for _, ch := range b.contexts {
		children = append(children, ch)
	}
	b.mu.Unlock()
	var group sync.WaitGroup
	for _, ch := range children {
		group.Add(1)
		go func(ch *child) {
			defer group.Done()
			if err := ch.stop(); err != nil {
				b.logger.Printf("context stop pid=%d: %v", ch.Info.Identity.PID, err)
			}
		}(ch)
	}
	group.Wait()
	b.monitors.Wait()
}

func listenBroker(name string) (net.Listener, error) {
	path, err := pipePath(name)
	if err != nil {
		return nil, err
	}
	return winio.ListenPipe(path, &winio.PipeConfig{
		SecurityDescriptor: "D:P(A;;GA;;;SY)(A;;GA;;;BA)",
		InputBufferSize:    8192, OutputBufferSize: 8192,
	})
}
