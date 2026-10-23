package main

import (
	"encoding/json"
	"testing"
)

func TestManagedContextProtocolGuards(t *testing.T) {
	sessionID := uint32(2)
	valid := []request{
		{Version: 1, Operation: "list-contexts"},
		{Version: 1, Operation: "launch-context", Target: "user", SessionID: &sessionID,
			AccountSID: "S-1-5-21-1-2-3-1001", LogonSID: "S-1-5-5-10-20"},
		{Version: 1, Operation: "resolve-context", Target: "system", ContextID: "0123456789abcdef0123456789abcdef"},
		{Version: 1, Operation: "resolve-context", Target: "user", SessionID: &sessionID,
			AccountSID: "S-1-5-21-1-2-3-1001", LogonSID: "S-1-5-5-10-20", ContextID: "0123456789abcdef0123456789abcdef"},
	}
	for _, req := range valid {
		raw, _ := json.Marshal(req)
		if _, err := decodeRequest(raw); err != nil {
			t.Fatalf("valid managed request rejected: %s: %v", raw, err)
		}
	}
	invalid := []request{
		{Version: 1, Operation: "list-contexts", AccountSID: "S-1-5-18"},
		{Version: 1, Operation: "resolve-context", Target: "system"},
		{Version: 1, Operation: "resolve-context", Target: "user", SessionID: &sessionID},
		{Version: 1, Operation: "launch-context", Target: "user", SessionID: &sessionID, AccountSID: "S-1-5-21-1-2-3-1001"},
		{Version: 1, Operation: "launch-context", Target: "user", SessionID: &sessionID, AccountSID: "S-1-5-18", LogonSID: "S-1-5-5-10-20"},
		{Version: 1, Operation: "launch-context", Target: "system", ContextID: "0123456789abcdef0123456789abcdef"},
	}
	for _, req := range invalid {
		raw, _ := json.Marshal(req)
		if _, err := decodeRequest(raw); err == nil {
			t.Fatalf("unguarded managed request accepted: %s", raw)
		}
	}
}

func TestManagedContextCannotReusePreviousLogon(t *testing.T) {
	expected := identity{SID: "S-1-5-21-1-2-3-1001", SessionID: 2}
	ch := &child{Info: childInfo{Identity: expected}, logonSID: "S-1-5-5-10-20"}
	if !matchingContext(ch, expected, ch.logonSID) {
		t.Fatal("exact retained token identity did not match")
	}
	if matchingContext(ch, expected, "S-1-5-5-10-21") || matchingContext(ch, expected, "") {
		t.Fatal("worker from previous logon accepted for current Windows session")
	}
	changed := expected
	changed.SID = "S-1-5-21-1-2-3-1002"
	if matchingContext(ch, changed, ch.logonSID) {
		t.Fatal("different account accepted")
	}
	changed = expected
	changed.SessionID++
	if matchingContext(ch, changed, ch.logonSID) {
		t.Fatal("different Windows session accepted")
	}
}

func TestManagedResolveOnlyReturnsExactRetainedWorker(t *testing.T) {
	expected := identity{SID: "S-1-5-21-1-2-3-1001", SessionID: 2}
	ch := &child{Info: childInfo{Identity: expected}, logonSID: "S-1-5-5-10-20", exit: make(chan struct{})}
	contexts := map[string]*child{"requested": ch, "other": {Info: childInfo{Identity: identity{SID: "S-1-5-21-1-2-3-1002", SessionID: 3}}}}
	if got, err := retainedContext(contexts, "requested", expected, ch.logonSID); err != nil || got != ch {
		t.Fatalf("exact worker resolution failed: %v", err)
	}
	for _, id := range []string{"missing", "other"} {
		if _, err := retainedContext(contexts, id, expected, ch.logonSID); err == nil {
			t.Fatal("resolution fell back to a different worker")
		}
	}
	if _, err := retainedContext(nil, "requested", expected, ch.logonSID); err == nil {
		t.Fatal("empty worker set accepted")
	}
	close(ch.exit)
	if _, err := retainedContext(contexts, "requested", expected, ch.logonSID); err == nil {
		t.Fatal("exited worker accepted")
	}
}
