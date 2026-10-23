package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func passwordRequest(t *testing.T, old, next string) []byte {
	t.Helper()
	raw, err := json.Marshal(request{
		Version: 1, Operation: "native-password-update", Target: "system",
		ContextID: strings.Repeat("a", 32), OldPassword: &old, NewPassword: &next,
	})
	if err != nil {
		t.Fatal(err)
	}
	return append(raw, '\n')
}

func TestNativePasswordFramingAndStrictInput(t *testing.T) {
	for _, next := range []string{"fixture", strings.Repeat("x", 4096),
		strings.Repeat("\x00", 4096), strings.Repeat("\U0001f600", 2048)} {
		raw := passwordRequest(t, strings.Repeat("\x01", 4096), next)
		if len(raw) > nativeFrameLimit {
			t.Fatal("documented maximum cannot fit private frame")
		}
		if _, err := decodeRequest(raw); err != nil {
			t.Fatalf("valid bounded request refused: %v", err)
		}
	}
	valid := string(passwordRequest(t, "", "synthetic-secret-do-not-log"))
	invalid := []string{
		string(passwordRequest(t, "", "")),
		string(passwordRequest(t, "", strings.Repeat("x", 4097))),
		string(passwordRequest(t, strings.Repeat("x", 4097), "x")),
		string(passwordRequest(t, "", strings.Repeat("\U0001f600", 2049))),
		strings.Replace(valid, `"target":"system"`, `"target":"user"`, 1),
		strings.Replace(valid, `"target":"system"`, `"target":"system","sessionId":2`, 1),
		strings.Replace(valid, `"version":1`, `"version":1,"callerSid":"S-1-5-18"`, 1),
		strings.Replace(valid, `"version":1`, `"version":1,"callerPid":7`, 1),
		strings.Replace(valid, `"oldPassword":""`, `"oldPassword":null`, 1),
		strings.Replace(valid, `"oldPassword":""`, `"oldPassword":false`, 1),
		strings.Replace(valid, `"oldPassword":""`, `"OLDPASSWORD":""`, 1),
		strings.Replace(valid, `"oldPassword":""`, `"oldPassword":"","oldPassword":""`, 1),
		strings.Replace(valid, `"oldPassword":"",`, "", 1),
		strings.Replace(valid, `"operation":"native-password-update"`,
			`"operation":"native-password-update","Operation":"identity"`, 1),
		valid + "{}",
		strings.Repeat(" ", nativeFrameLimit) + valid,
		strings.Replace(valid, "synthetic-secret-do-not-log", string([]byte{0xff}), 1),
		strings.Replace(valid, "synthetic-secret-do-not-log", `\ud800`, 1),
		strings.Replace(valid, "synthetic-secret-do-not-log", `\udc00`, 1),
		strings.Replace(valid, "synthetic-secret-do-not-log", `\ud800\u0041`, 1),
		`{"version":1,"operation":"identity","newPassword":"synthetic-secret-do-not-log"}`,
		`{"version":1,"operation":"redeem-native-password","contextId":"` + strings.Repeat("a", 32) +
			`","admissionId":"` + strings.Repeat("g", 64) + `"}`,
	}
	for n, raw := range invalid {
		if _, err := decodeRequest([]byte(raw)); err == nil {
			t.Errorf("invalid case %d accepted", n)
		} else if strings.Contains(err.Error(), "synthetic-secret-do-not-log") {
			t.Errorf("case %d leaked credential in error", n)
		}
	}
	legacy := `{"version":1,"operation":"identity"}` + strings.Repeat(" ", 8192)
	if _, err := decodeRequest([]byte(legacy)); err == nil {
		t.Fatal("legacy frame cap widened")
	}
	for _, text := range []string{`\ud800\udc00`, `\\ud800`, `\\\"`, `\ufffd`} {
		raw := strings.Replace(valid, "synthetic-secret-do-not-log", text, 1)
		if _, err := decodeRequest([]byte(raw)); err != nil {
			t.Fatal("valid escaped Unicode rejected")
		}
	}
}

func newSyntheticAdmission() *passwordAdmission {
	return &passwordAdmission{
		expires: time.Now().Add(time.Second),
		payload: passwordPayload{
			AdmissionID: strings.Repeat("b", 64), Operation: "native-password-update",
			ContextID: strings.Repeat("a", 32),
			Runtime:   runtimeGeneration{PID: 1234, CreationTime: "01df000012345678"},
			Caller: callerIdentity{identity: identity{SID: "S-1-5-21-1-2-3-500",
				SessionID: 2, PID: 77, Elevated: true}, LogonSID: "S-1-5-5-1-2", CreationTime: "01de000012345678"},
			OldPassword: "synthetic-old", NewPassword: "synthetic-new",
		},
	}
}

func redeemRequest(a *passwordAdmission) request {
	return request{Version: 1, Operation: "redeem-native-password",
		ContextID: a.payload.ContextID, AdmissionID: a.payload.AdmissionID}
}

func TestNativePasswordAdmissionOneUseAndExactBinding(t *testing.T) {
	for _, change := range []func(*request){
		func(r *request) { r.ContextID = strings.Repeat("c", 32) },
		func(r *request) { r.AdmissionID = strings.Repeat("c", 64) },
		func(r *request) { r.Operation = "native-password-update" },
	} {
		a := newSyntheticAdmission()
		req := redeemRequest(a)
		change(&req)
		if _, err := a.consume(req, time.Now()); !errors.Is(err, errNativeAdmission) || a.redeemed {
			t.Fatal("wrong operation/context/capability accepted or consumed")
		}
	}
	a := newSyntheticAdmission()
	req := redeemRequest(a)
	if _, err := a.consume(req, a.expires); !errors.Is(err, errNativeAdmission) {
		t.Fatal("deadline boundary accepted")
	}
	if _, err := a.consume(req, a.expires.Add(time.Second)); !errors.Is(err, errNativeAdmission) {
		t.Fatal("expired admission accepted")
	}
	payload, err := a.consume(req, time.Now())
	if err != nil || payload.OldPassword != "synthetic-old" || payload.NewPassword != "synthetic-new" ||
		payload.Runtime.CreationTime != "01df000012345678" || payload.Caller.PID != 77 {
		t.Fatal("bound payload lost")
	}
	if a.payload.OldPassword != "" || a.payload.NewPassword != "" {
		t.Fatal("redeemed store retained credentials")
	}
	if _, err := a.consume(req, time.Now()); !errors.Is(err, errNativeAdmission) {
		t.Fatal("replay accepted")
	}
	reply := response{Result: payload}
	reqSecretsClear(&reply)
	if payload.OldPassword != "" || payload.NewPassword != "" {
		t.Fatal("reply cleanup retained credentials")
	}
	a.destroy()
}

func TestNativePasswordConcurrentOneUse(t *testing.T) {
	a := newSyntheticAdmission()
	req := redeemRequest(a)
	var group sync.WaitGroup
	var successes int
	for i := 0; i < 32; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			a.mu.Lock()
			defer a.mu.Unlock()
			if _, err := a.consume(req, time.Now()); err == nil {
				successes++
			}
		}()
	}
	group.Wait()
	if successes != 1 {
		t.Fatalf("one-use admitted %d redemptions", successes)
	}
}

func TestNativePasswordOutcomeOnlyKnownBoundCommit(t *testing.T) {
	a := newSyntheticAdmission()
	encode := func(ok, committed bool, code string) []byte {
		t.Helper()
		reply := map[string]any{
			"version": 1, "ok": ok,
			"result": passwordOutcome{PID: a.payload.Runtime.PID, ContextID: a.payload.ContextID,
				AdmissionID: a.payload.AdmissionID, Committed: committed},
		}
		if code != "" {
			reply["error"] = map[string]string{"code": code}
		}
		raw, _ := json.Marshal(reply)
		return raw
	}
	good := encode(true, true, "")
	if result, err := validatePasswordOutcome(good, a.payload, true); err != nil || !result.Committed {
		t.Fatal("confirmed commit refused")
	}
	for _, code := range []string{
		"ERR_NATIVE_PASSWORD_INVALID_INPUT", "ERR_NATIVE_PASSWORD_OLD_PASSWORD",
		"ERR_NATIVE_PASSWORD_PROFILE_UNAVAILABLE", "ERR_NATIVE_PASSWORD_CONFLICT", "ERR_NATIVE_PASSWORD_STORAGE",
	} {
		result, err := validatePasswordOutcome(encode(false, false, code), a.payload, true)
		if err == nil || err.Error() != code || result == nil || result.Committed {
			t.Fatal("fixed runtime rejection lost")
		}
	}
	result, err := validatePasswordOutcome(encode(false, true, "ERR_NATIVE_PASSWORD_COMMITTED_INVALIDATION_FAILED"), a.payload, true)
	if result == nil || !result.Committed || err == nil || err.Error() != "ERR_NATIVE_PASSWORD_COMMITTED_INVALIDATION_FAILED" {
		t.Fatal("committed invalidation failure became success or retryable failure")
	}
	for _, raw := range [][]byte{
		encode(true, false, ""),
		encode(true, true, "ERR_NATIVE_PASSWORD_STORAGE"),
		encode(false, true, "ERR_NATIVE_PASSWORD_STORAGE"),
		encode(false, false, "synthetic-secret-do-not-log"),
		[]byte(strings.Replace(string(good), a.payload.ContextID, strings.Repeat("c", 32), 1)),
		[]byte(strings.Replace(string(good), a.payload.AdmissionID, strings.Repeat("c", 64), 1)),
		[]byte(strings.Replace(string(good), `"pid":1234`, `"pid":1235`, 1)),
		[]byte(strings.Replace(string(good), `"committed":true`, `"committed":true,"committed":true`, 1)),
		[]byte(strings.Replace(string(good), `"committed":true`, `"Committed":true`, 1)),
		[]byte(strings.Replace(string(good), `"committed":true`, `"committed":null`, 1)),
		[]byte(strings.Replace(string(encode(false, false, "ERR_NATIVE_PASSWORD_STORAGE")), `,"committed":false`, "", 1)),
		append(good, []byte("{}")...),
		[]byte(`{"oldPassword":"synthetic-secret-do-not-log"}`),
	} {
		if _, err := validatePasswordOutcome(raw, a.payload, true); err == nil ||
			err.Error() != "ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN" {
			t.Fatal("unbound/malformed/secret runtime reply accepted or leaked")
		}
	}
	if _, err := validatePasswordOutcome(good, a.payload, false); err == nil {
		t.Fatal("runtime success accepted without actual redemption")
	}
	admissionFailure := encode(false, false, "ERR_NATIVE_PASSWORD_ADMISSION")
	if result, err := validatePasswordOutcome(admissionFailure, a.payload, false); !errors.Is(err, errNativeAdmission) ||
		result == nil || result.Committed {
		t.Fatal("genuine unredeemed denial not preserved")
	}
	if _, err := validatePasswordOutcome(admissionFailure, a.payload, true); err == nil ||
		err.Error() != "ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN" {
		t.Fatal("replayed/failed helper denial overrode already-redeemed operation")
	}
}

func TestNativePasswordOSCallerAndProcessLifetime(t *testing.T) {
	id, _ := randomID()
	path, _ := pipePath("AnubisHost-QA-" + id)
	listener, err := winio.ListenPipe(path, &winio.PipeConfig{SecurityDescriptor: adminSDDL})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	done := make(chan *authenticatedCaller, 1)
	fail := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			fail <- err
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(3 * time.Second))
		if _, err := bufio.NewReader(conn).ReadSlice('\n'); err != nil {
			fail <- err
			return
		}
		caller, err := authenticate(conn)
		if err != nil {
			fail <- err
			return
		}
		done <- caller
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := winio.DialPipeAccessImpLevel(ctx, path, windows.GENERIC_READ|windows.GENERIC_WRITE, winio.PipeImpLevelIdentification)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := io.WriteString(conn, "{}\n"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-fail:
		t.Fatal(err)
	case caller := <-done:
		defer caller.close()
		i, err := currentIdentity()
		if err != nil {
			t.Fatal(err)
		}
		created, err := processCreation(windows.CurrentProcess())
		if err != nil || caller.CreationTime != created || caller.PID != windows.GetCurrentProcessId() ||
			caller.SID != i.SID || caller.SessionID != i.SessionID || caller.LogonSID == "" {
			t.Fatal("caller not bound to real OS token/PID/full creation/logon")
		}
		if liveProcess(caller.process, "01df000000000000") {
			t.Fatal("wrong process generation accepted")
		}
		if err := verifyProcessImage(caller.process, filepath.Join(t.TempDir(), hostFile)); err == nil {
			t.Fatal("different image accepted")
		}
		caller.close()
		if liveProcess(caller.process, created) {
			t.Fatal("closed process handle accepted")
		}
	case <-ctx.Done():
		t.Fatal("bounded caller authentication timed out")
	}
}

func TestNativePasswordAdmissionRefusesUntrustedCallersAndPrivateFlag(t *testing.T) {
	a := newSyntheticAdmission()
	b := &broker{admission: a}
	req := redeemRequest(a)
	for _, caller := range []*authenticatedCaller{
		nil,
		{callerIdentity: callerIdentity{identity: identity{SID: "S-1-5-18", SessionID: 0, Elevated: true}}},
		{callerIdentity: callerIdentity{identity: identity{SID: "S-1-5-21-1-2-3-500", SessionID: 2, Elevated: true}}},
	} {
		if _, err := b.redeemNativePassword(req, caller); !errors.Is(err, errNativeAdmission) {
			t.Fatal("fabricated caller redeemed without actual OS/runtime/image/parent")
		}
		if localPasswordAdministrator(caller) {
			t.Fatal("fabricated or SYSTEM caller authorized provisioning")
		}
	}
	if a.redeemed {
		t.Fatal("failed caller burned valid admission")
	}
	req.Operation = "native-password-update"
	if err := brokerClient("AnubisHost", req, false); err == nil ||
		err.Error() != "ERR_NATIVE_PASSWORD_PRIVATE_CHANNEL_REQUIRED" {
		t.Fatal("native password accepted outside explicit private stdio")
	}
	if err := command([]string{"broker-client", "--operation", "native-password-update", "--target", "system"}); err == nil ||
		err.Error() != "ERR_NATIVE_PASSWORD_PRIVATE_CHANNEL_REQUIRED" {
		t.Fatal("native password operation exposed in selector argv")
	}
}

func TestNativePasswordRuntimeGenerationReplacementRefused(t *testing.T) {
	a := newSyntheticAdmission()
	a.child = &child{Info: childInfo{ContextID: a.payload.ContextID,
		Identity: identity{SID: "S-1-5-18", SessionID: 0, PID: a.payload.Runtime.PID}}}
	b := &broker{machine: &child{Info: a.child.Info}}
	if b.currentAdmissionRuntime(a) {
		t.Fatal("different retained child with copied public identity accepted")
	}
	b.machine = a.child
	b.stopping = true
	if b.currentAdmissionRuntime(a) {
		t.Fatal("service stopping accepted")
	}
	b.stopping = false
	if b.currentAdmissionRuntime(a) {
		t.Fatal("SYSTEM identity JSON accepted without retained live process handle")
	}
}

func TestNativePasswordOSParentPIDAndFullCreation(t *testing.T) {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION|windows.SYNCHRONIZE, false, windows.GetCurrentProcessId())
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(process)
	creation, err := processCreation(process)
	if err != nil {
		t.Fatal(err)
	}
	var info windows.PROCESS_BASIC_INFORMATION
	if err := windows.NtQueryInformationProcess(process, windows.ProcessBasicInformation,
		unsafe.Pointer(&info), uint32(unsafe.Sizeof(info)), nil); err != nil {
		t.Fatal(err)
	}
	parent, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION|windows.SYNCHRONIZE, false,
		uint32(info.InheritedFromUniqueProcessId))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(parent)
	parentCreation, err := processCreation(parent)
	if err != nil {
		t.Fatal(err)
	}
	caller := &authenticatedCaller{process: process, callerIdentity: callerIdentity{CreationTime: creation}}
	generation := runtimeGeneration{PID: uint32(info.InheritedFromUniqueProcessId), CreationTime: parentCreation}
	if !runtimeParentMatches(caller, generation, parent) {
		t.Fatal("real OS parent/full creation not recognized")
	}
	generation.PID++
	if runtimeParentMatches(caller, generation, parent) {
		t.Fatal("claimed different parent PID accepted")
	}
	generation.PID--
	generation.CreationTime = creation
	if runtimeParentMatches(caller, generation, parent) {
		t.Fatal("parent creation not older than helper accepted")
	}
	generation.CreationTime = parentCreation[:15] + "0"
	if generation.CreationTime == parentCreation {
		generation.CreationTime = parentCreation[:15] + "1"
	}
	if runtimeParentMatches(caller, generation, parent) {
		t.Fatal("different full parent creation accepted")
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyProcessImage(process, exe); err == nil {
		t.Fatal("unprotected test executable accepted as installed helper")
	}
}

func TestNativePasswordControlSocketNeverReceivesCredentials(t *testing.T) {
	if _, err := authenticate(&nonNativeConn{}); err == nil {
		t.Fatal("non-native transport authorized")
	}
	source, err := os.ReadFile("password_admission_windows.go")
	if err != nil {
		t.Fatal(err)
	}
	code := string(source)
	start := strings.Index(code, "func (a *passwordAdmission) callRuntime(")
	end := strings.Index(code, "func validatePasswordOutcome(")
	if start == -1 || end <= start {
		t.Fatal("missing runtime admission transport")
	}
	transport := code[start:end]
	if strings.Contains(transport, "OldPassword") || strings.Contains(transport, "NewPassword") {
		t.Fatal("credentials introduced into BA-accessible runtime request")
	}
}

type nonNativeConn struct{ net.Conn }

func TestNativePasswordLateRedemptionCannotFollowUncommittedDenial(t *testing.T) {
	for i := 0; i < 50; i++ {
		a := newSyntheticAdmission()
		req := redeemRequest(a)
		start := make(chan struct{})
		done := make(chan bool, 1)
		go func() {
			<-start
			a.mu.Lock()
			defer a.mu.Unlock()
			_, err := a.consume(req, time.Now())
			done <- err == nil
		}()
		close(start)
		payload, redeemed := a.snapshotAndRevoke()
		consumed := <-done
		if consumed != redeemed || payload.OldPassword != "" || payload.NewPassword != "" ||
			a.payload.OldPassword != "" || a.payload.NewPassword != "" {
			t.Fatal("revocation did not atomically preserve redemption fact and clear secrets")
		}
		a.mu.Lock()
		_, err := a.consume(req, time.Now())
		a.mu.Unlock()
		if !errors.Is(err, errNativeAdmission) {
			t.Fatal("late helper consumed revoked admission after possible uncommitted denial")
		}
	}
}

func TestNativePasswordPrivatePipesRejectFilesBeforeReading(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	if err := privateStandardPipes(windows.Handle(read.Fd()), windows.Handle(write.Fd())); err != nil {
		t.Fatal("anonymous private stdio refused")
	}
	file, err := os.CreateTemp(t.TempDir(), "nonsecret-stdio-guard")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	for _, handles := range [][2]windows.Handle{
		{windows.Handle(file.Fd()), windows.Handle(write.Fd())},
		{windows.Handle(read.Fd()), windows.Handle(file.Fd())},
		{0, windows.Handle(write.Fd())},
	} {
		if err := privateStandardPipes(handles[0], handles[1]); err == nil {
			t.Fatal("file/invalid stdio permitted for private bridge")
		}
	}
}

func TestNativePasswordInitiatorRoleBoundaries(t *testing.T) {
	creation, err := processCreation(windows.CurrentProcess())
	if err != nil {
		t.Fatal(err)
	}
	base := authenticatedCaller{
		process: windows.CurrentProcess(), interactive: true,
		callerIdentity: callerIdentity{
			identity: identity{SID: "S-1-5-21-1-2-3-500", Elevated: true, SessionID: 2},
			LogonSID: "S-1-5-5-1-2", CreationTime: creation,
		},
	}
	if !localPasswordAdministrator(&base) {
		t.Fatal("complete already-authenticated role rejected")
	}
	for _, change := range []func(*authenticatedCaller){
		func(c *authenticatedCaller) { c.SID = "S-1-5-18" },
		func(c *authenticatedCaller) { c.Elevated = false },
		func(c *authenticatedCaller) { c.SessionID = 0 },
		func(c *authenticatedCaller) { c.interactive = false },
		func(c *authenticatedCaller) { c.network = true },
		func(c *authenticatedCaller) { c.LogonSID = "" },
		func(c *authenticatedCaller) { c.CreationTime = "0000000000000001" },
		func(c *authenticatedCaller) { c.process = 0 },
	} {
		caller := base
		change(&caller)
		if localPasswordAdministrator(&caller) {
			t.Fatal("ineligible local role accepted")
		}
	}
	b := &broker{}
	req, err := decodeRequest(passwordRequest(t, "", "synthetic-new"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.beginPasswordAdmission(req, &base); !errors.Is(err, errNativeAdmission) {
		t.Fatal("missing canonical owned runtime accepted")
	}
	if b.admission != nil {
		t.Fatal("failed admission retained a pending credential operation")
	}
}
