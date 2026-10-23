package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
	"unsafe"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

const nativeFrameLimit = 65536

var errNativeAdmission = errors.New("ERR_NATIVE_PASSWORD_ADMISSION")

func privateStandardPipes(input, output windows.Handle) error {
	for _, handle := range []windows.Handle{input, output} {
		kind, err := windows.GetFileType(handle)
		if err != nil || kind != windows.FILE_TYPE_PIPE {
			return errors.New("ERR_NATIVE_PASSWORD_PRIVATE_CHANNEL_REQUIRED")
		}
	}
	return nil
}

type callerIdentity struct {
	identity
	LogonSID     string `json:"logonSid"`
	CreationTime string `json:"creationTime"`
}

type authenticatedCaller struct {
	callerIdentity
	process     windows.Handle
	network     bool
	interactive bool
}

func (c *authenticatedCaller) close() {
	if c.process != 0 {
		windows.CloseHandle(c.process)
		c.process = 0
	}
}

func processCreation(process windows.Handle) (string, error) {
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(process, &created, &exited, &kernel, &user); err != nil {
		return "", err
	}
	return fmt.Sprintf("%08x%08x", created.HighDateTime, created.LowDateTime), nil
}

func liveProcess(process windows.Handle, creation string) bool {
	state, err := windows.WaitForSingleObject(process, 0)
	if err != nil || state != uint32(windows.WAIT_TIMEOUT) {
		return false
	}
	actual, err := processCreation(process)
	return err == nil && creation != "" && actual == creation
}

func tokenGroup(token windows.Token, sid string) (bool, error) {
	groups, err := token.GetTokenGroups()
	if err != nil {
		return false, err
	}
	for _, group := range groups.AllGroups() {
		if group.Sid.String() == sid && group.Attributes&windows.SE_GROUP_ENABLED != 0 {
			return true, nil
		}
	}
	return false, nil
}

func captureCaller(pipe windows.Handle, token windows.Token, i identity) (*authenticatedCaller, error) {
	var pid uint32
	if err := windows.GetNamedPipeClientProcessId(pipe, &pid); err != nil || pid == 0 {
		return nil, errNativeAdmission
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_INFORMATION|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		return nil, errNativeAdmission
	}
	c := &authenticatedCaller{process: process}
	success := false
	defer func() {
		if !success {
			c.close()
		}
	}()
	c.identity = i
	c.PID = pid
	c.LogonSID, err = logonSID(token)
	if err != nil {
		return nil, errNativeAdmission
	}
	c.network, err = tokenGroup(token, "S-1-5-2")
	if err != nil {
		return nil, errNativeAdmission
	}
	c.interactive, err = tokenGroup(token, "S-1-5-4")
	if err != nil {
		return nil, errNativeAdmission
	}
	c.CreationTime, err = processCreation(process)
	if err != nil || !liveProcess(process, c.CreationTime) {
		return nil, errNativeAdmission
	}
	var primary windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &primary); err != nil {
		return nil, errNativeAdmission
	}
	defer primary.Close()
	actual, err := tokenIdentity(primary, pid)
	if err != nil {
		return nil, errNativeAdmission
	}
	logon, err := logonSID(primary)
	if err != nil || actual.SID != c.SID || actual.SessionID != c.SessionID ||
		actual.Elevated != c.Elevated || logon != c.LogonSID {
		return nil, errNativeAdmission
	}
	restricted, err := primary.IsRestricted()
	if err != nil || restricted {
		return nil, errNativeAdmission
	}
	success = true
	return c, nil
}

func nativePasswordOperation(operation string) bool {
	return operation == "native-password-update" || operation == "redeem-native-password"
}

func passwordLength(s string) int {
	length := 0
	for _, r := range s {
		length++
		if r > 0xffff {
			length++
		}
	}
	return length
}

func validatePasswordRequest(raw []byte, req request) error {
	if !utf8.Valid(raw) || !validJSONUnicode(raw) {
		return errors.New("ERR_NATIVE_PASSWORD_REQUEST")
	}
	fields := []string{"version", "operation", "contextId"}
	if req.Operation == "native-password-update" {
		fields = append(fields, "target", "oldPassword", "newPassword")
	} else {
		fields = append(fields, "admissionId")
	}
	_, ok := strictNativeObject(raw, fields, nil)
	if !ok || !contextIDPattern.MatchString(req.ContextID) {
		return errors.New("ERR_NATIVE_PASSWORD_REQUEST")
	}
	if req.Operation == "redeem-native-password" {
		if !validAdmissionID(req.AdmissionID) {
			return errors.New("ERR_NATIVE_PASSWORD_REQUEST")
		}
		return nil
	}
	if req.Target != "system" || req.OldPassword == nil || req.NewPassword == nil ||
		*req.NewPassword == "" || passwordLength(*req.NewPassword) > 4096 ||
		passwordLength(*req.OldPassword) > 4096 {
		return errors.New("ERR_NATIVE_PASSWORD_INVALID_INPUT")
	}
	return nil
}

// encoding/json alone accepts duplicate and case-insensitive field names.
func strictNativeObject(raw []byte, required, optional []string) (map[string]json.RawMessage, bool) {
	allowed := make(map[string]bool)
	for _, key := range append(append([]string{}, required...), optional...) {
		allowed[key] = true
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return nil, false
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		key, err := decoder.Token()
		name, ok := key.(string)
		if err != nil || !ok || fields[name] != nil || !allowed[name] {
			return nil, false
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, false
		}
		fields[name] = value
	}
	if end, err := decoder.Token(); err != nil || end != json.Delim('}') ||
		decoder.Decode(new(any)) != io.EOF {
		return nil, false
	}
	for _, key := range required {
		if fields[key] == nil {
			return nil, false
		}
	}
	return fields, true
}

func validAdmissionID(id string) bool {
	if len(id) != 64 || strings.ToLower(id) != id {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

func validJSONUnicode(raw []byte) bool {
	inString := false
	for i := 0; i < len(raw); i++ {
		if raw[i] == '"' {
			inString = !inString
		} else if inString && raw[i] == '\\' {
			if i+1 >= len(raw) {
				return false
			}
			if raw[i+1] != 'u' {
				i++
				continue
			}
			if i+6 > len(raw) {
				return false
			}
			unit, err := strconv.ParseUint(string(raw[i+2:i+6]), 16, 16)
			if err != nil || unit >= 0xdc00 && unit <= 0xdfff {
				return false
			}
			if unit >= 0xd800 && unit <= 0xdbff {
				if i+12 > len(raw) || raw[i+6] != '\\' || raw[i+7] != 'u' {
					return false
				}
				low, err := strconv.ParseUint(string(raw[i+8:i+12]), 16, 16)
				if err != nil || low < 0xdc00 || low > 0xdfff {
					return false
				}
				i += 11
			} else {
				i += 5
			}
		}
	}
	return true
}

type runtimeGeneration struct {
	PID          uint32 `json:"pid"`
	CreationTime string `json:"creationTime"`
}

type passwordPayload struct {
	AdmissionID string            `json:"admissionId"`
	Operation   string            `json:"operation"`
	ContextID   string            `json:"contextId"`
	Runtime     runtimeGeneration `json:"runtime"`
	Caller      callerIdentity    `json:"caller"`
	OldPassword string            `json:"oldPassword"`
	NewPassword string            `json:"newPassword"`
}

func reqSecretsClear(reply *response) {
	if payload, ok := reply.Result.(*passwordPayload); ok {
		payload.OldPassword, payload.NewPassword = "", ""
	}
}

func clearRequestSecrets(req *request) {
	if req.OldPassword != nil {
		*req.OldPassword = ""
	}
	if req.NewPassword != nil {
		*req.NewPassword = ""
	}
}

type passwordAdmission struct {
	mu        sync.Mutex
	payload   passwordPayload
	child     *child
	process   windows.Handle
	initiator *authenticatedCaller
	expires   time.Time
	redeemed  bool
	revoked   bool
}

func (a *passwordAdmission) destroy() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.payload.OldPassword, a.payload.NewPassword = "", ""
	a.revoked = true
	if a.process != 0 {
		windows.CloseHandle(a.process)
		a.process = 0
	}
}

func localPasswordAdministrator(c *authenticatedCaller) bool {
	return c != nil && c.SID != "S-1-5-18" && c.Elevated && c.SessionID != 0 &&
		c.interactive && !c.network && logonSIDPattern.MatchString(c.LogonSID) &&
		liveProcess(c.process, c.CreationTime)
}

func (b *broker) currentAdmissionRuntime(a *passwordAdmission) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return !b.stopping && b.machine == a.child &&
		a.child.Info.ContextID == a.payload.ContextID &&
		a.child.Info.Identity.PID == a.payload.Runtime.PID &&
		a.child.creationTime == a.payload.Runtime.CreationTime &&
		a.child.Info.Identity.SID == "S-1-5-18" && a.child.Info.Identity.SessionID == 0 &&
		liveProcess(a.process, a.payload.Runtime.CreationTime) && systemRuntime(a.process)
}

func (b *broker) beginPasswordAdmission(req request, caller *authenticatedCaller) (*passwordAdmission, error) {
	if !localPasswordAdministrator(caller) {
		return nil, errors.New("ERR_NATIVE_PASSWORD_ELEVATION_REQUIRED")
	}
	b.admissionMu.Lock()
	defer b.admissionMu.Unlock()
	if b.admission != nil {
		return nil, errors.New("ERR_NATIVE_PASSWORD_BUSY")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := b.machine
	if b.stopping || ch == nil || ch.Info.ContextID != req.ContextID ||
		ch.Info.Identity.SID != "S-1-5-18" || ch.Info.Identity.SessionID != 0 ||
		!liveProcess(ch.process, ch.creationTime) || !systemRuntime(ch.process) {
		return nil, errNativeAdmission
	}
	if err := verifyProcessImage(ch.process, filepath.Join(b.config.InstallDir, b.config.RuntimePath)); err != nil {
		return nil, errNativeAdmission
	}
	var process windows.Handle
	if err := windows.DuplicateHandle(windows.CurrentProcess(), ch.process, windows.CurrentProcess(),
		&process, 0, false, windows.DUPLICATE_SAME_ACCESS); err != nil {
		return nil, errNativeAdmission
	}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		windows.CloseHandle(process)
		return nil, errNativeAdmission
	}
	a := &passwordAdmission{
		child: ch, process: process, initiator: caller, expires: time.Now().Add(5 * time.Second),
		payload: passwordPayload{
			AdmissionID: hex.EncodeToString(nonce[:]), Operation: "native-password-update",
			ContextID: req.ContextID, Caller: caller.callerIdentity,
			Runtime:     runtimeGeneration{PID: ch.Info.Identity.PID, CreationTime: ch.creationTime},
			OldPassword: *req.OldPassword, NewPassword: *req.NewPassword,
		},
	}
	b.admission = a
	return a, nil
}

func verifyProcessImage(process windows.Handle, expected string) error {
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err := windows.QueryFullProcessImageName(process, 0, &buffer[0], &size); err != nil {
		return errNativeAdmission
	}

	path := windows.UTF16ToString(buffer[:size])
	if !samePath(path, expected) {
		return errNativeAdmission
	}
	programFiles, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil || protectedChain(programFiles, path) != nil {
		return errNativeAdmission
	}
	return nil
}

func systemRuntime(process windows.Handle) bool {
	var token windows.Token
	if windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token) != nil {
		return false
	}
	defer token.Close()
	actual, err := tokenIdentity(token, 0)
	if err != nil || actual.SID != "S-1-5-18" || actual.SessionID != 0 {
		return false
	}
	restricted, err := token.IsRestricted()
	return err == nil && !restricted
}

func (b *broker) redeemNativePassword(req request, caller *authenticatedCaller) (any, error) {
	b.admissionMu.Lock()
	defer b.admissionMu.Unlock()
	a := b.admission
	if a == nil {
		return nil, errNativeAdmission
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if caller == nil || caller.SID != "S-1-5-18" || caller.SessionID != 0 || caller.network ||
		!liveProcess(caller.process, caller.CreationTime) ||
		!localPasswordAdministrator(a.initiator) || !b.currentAdmissionRuntime(a) {
		return nil, errNativeAdmission
	}
	if err := verifyProcessImage(caller.process, filepath.Join(b.config.InstallDir, hostFile)); err != nil {
		return nil, errNativeAdmission
	}
	if !runtimeParentMatches(caller, a.payload.Runtime, a.process) {
		return nil, errNativeAdmission
	}
	return a.consume(req, time.Now())
}

func runtimeParentMatches(caller *authenticatedCaller, generation runtimeGeneration, parent windows.Handle) bool {
	var info windows.PROCESS_BASIC_INFORMATION
	parentPID, err := windows.GetProcessId(parent)
	return caller != nil && generation.PID != 0 && generation.CreationTime != "" &&
		err == nil && parentPID == generation.PID && liveProcess(parent, generation.CreationTime) &&
		windows.NtQueryInformationProcess(caller.process, windows.ProcessBasicInformation,
			unsafe.Pointer(&info), uint32(unsafe.Sizeof(info)), nil) == nil &&
		info.InheritedFromUniqueProcessId == uintptr(generation.PID) &&
		caller.CreationTime > generation.CreationTime
}

func (a *passwordAdmission) consume(req request, now time.Time) (*passwordPayload, error) {
	if a.redeemed || a.revoked || !now.Before(a.expires) || req.Operation != "redeem-native-password" ||
		req.AdmissionID != a.payload.AdmissionID || req.ContextID != a.payload.ContextID {
		return nil, errNativeAdmission
	}
	a.redeemed = true
	payload := a.payload
	a.payload.OldPassword, a.payload.NewPassword = "", ""
	return &payload, nil
}

func (a *passwordAdmission) snapshotAndRevoke() (passwordPayload, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	payload := a.payload
	payload.OldPassword, payload.NewPassword = "", ""
	a.payload.OldPassword, a.payload.NewPassword = "", ""
	a.revoked = true
	return payload, a.redeemed
}

type passwordOutcome struct {
	PID         uint32 `json:"pid"`
	ContextID   string `json:"contextId"`
	AdmissionID string `json:"admissionId"`
	Committed   bool   `json:"committed"`
}

func (b *broker) updateNativePassword(ctx context.Context, req request, caller *authenticatedCaller) (any, error) {
	a, err := b.beginPasswordAdmission(req, caller)
	if err != nil {
		return nil, err
	}
	defer func() {
		b.admissionMu.Lock()
		b.admission = nil
		a.destroy()
		b.admissionMu.Unlock()
	}()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	outcome, err := a.callRuntime(ctx)
	if !b.currentAdmissionRuntime(a) {
		return nil, errors.New("ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN")
	}
	return outcome, err
}

func (a *passwordAdmission) callRuntime(ctx context.Context) (*passwordOutcome, error) {
	conn, err := winio.DialPipeContext(ctx, a.child.Info.ControlPipe)
	if err != nil {
		return nil, errors.New("ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN")
	}
	defer conn.Close()
	fd, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return nil, errNativeAdmission
	}
	var pid uint32
	if windows.GetNamedPipeServerProcessId(windows.Handle(fd.Fd()), &pid) != nil ||
		pid != a.payload.Runtime.PID || !liveProcess(a.process, a.payload.Runtime.CreationTime) ||
		a.child.validatePipeACL(windows.Handle(fd.Fd())) != nil {
		return nil, errNativeAdmission
	}
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return nil, errors.New("ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN")
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-done:
		}
	}()
	if err := json.NewEncoder(conn).Encode(struct {
		Version     int    `json:"version"`
		Operation   string `json:"operation"`
		ContextID   string `json:"contextId"`
		AdmissionID string `json:"admissionId"`
	}{1, "native-password-update", a.payload.ContextID, a.payload.AdmissionID}); err != nil {
		return nil, errors.New("ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN")
	}
	raw, err := bufio.NewReaderSize(conn, 2048).ReadSlice('\n')
	defer clear(raw)
	if err != nil {
		return nil, errors.New("ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN")
	}
	payload, redeemed := a.snapshotAndRevoke()
	return validatePasswordOutcome(raw, payload, redeemed)
}

func validatePasswordOutcome(raw []byte, payload passwordPayload, redeemed bool) (*passwordOutcome, error) {
	fields, ok := strictNativeObject(raw, []string{"version", "ok", "result"}, []string{"error"})
	if !ok {
		return nil, errors.New("ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN")
	}
	if _, ok := strictNativeObject(fields["result"], []string{"pid", "contextId", "admissionId", "committed"}, nil); !ok {
		return nil, errors.New("ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN")
	}
	if fields["error"] != nil {
		if _, ok := strictNativeObject(fields["error"], []string{"code"}, nil); !ok {
			return nil, errors.New("ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN")
		}
	}
	var reply struct {
		Version int             `json:"version"`
		OK      bool            `json:"ok"`
		Result  passwordOutcome `json:"result"`
		Error   *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&reply) != nil || decoder.Decode(new(any)) != io.EOF ||
		reply.Version != 1 || reply.Result.PID != payload.Runtime.PID ||
		reply.Result.ContextID != payload.ContextID || reply.Result.AdmissionID != payload.AdmissionID {
		return nil, errors.New("ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN")
	}
	if !redeemed {
		if !reply.OK && !reply.Result.Committed && reply.Error != nil &&
			reply.Error.Code == "ERR_NATIVE_PASSWORD_ADMISSION" {
			return &reply.Result, errNativeAdmission
		}
		return nil, errors.New("ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN")
	}
	if reply.OK && reply.Error == nil && reply.Result.Committed {
		return &reply.Result, nil
	}
	if reply.OK || reply.Error == nil {
		return nil, errors.New("ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN")
	}
	if reply.Error.Code == "ERR_NATIVE_PASSWORD_COMMITTED_INVALIDATION_FAILED" && reply.Result.Committed {
		return &reply.Result, errors.New(reply.Error.Code)
	}
	allowed := map[string]bool{
		"ERR_NATIVE_PASSWORD_INVALID_INPUT": true, "ERR_NATIVE_PASSWORD_OLD_PASSWORD": true,
		"ERR_NATIVE_PASSWORD_PROFILE_UNAVAILABLE": true, "ERR_NATIVE_PASSWORD_CONFLICT": true,
		"ERR_NATIVE_PASSWORD_STORAGE": true,
	}
	if !reply.Result.Committed && allowed[reply.Error.Code] {
		return &reply.Result, errors.New(reply.Error.Code)
	}
	return nil, errors.New("ERR_NATIVE_PASSWORD_OUTCOME_UNKNOWN")
}
