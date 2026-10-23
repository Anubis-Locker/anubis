package main

import (
	"errors"
	"fmt"
	"regexp"
	"time"

	"golang.org/x/sys/windows"
)

var runtimePipePattern = regexp.MustCompile(`^\\\\\.\\pipe\\AnubisHost(?:-QA-[A-Za-z0-9-]{1,40})?-context-[a-f0-9]{32}$`)

func logonSID(token windows.Token) (string, error) {
	groups, err := token.GetTokenGroups()
	if err != nil {
		return "", err
	}
	for _, group := range groups.AllGroups() {
		if group.Attributes&windows.SE_GROUP_LOGON_ID == windows.SE_GROUP_LOGON_ID {
			return group.Sid.String(), nil
		}
	}
	return "", nil
}

func secureRuntimePipe(path string, serverPID uint32) error {
	if !runtimePipePattern.MatchString(path) || serverPID == 0 {
		return errors.New("requires exact host-generated local runtime pipe and nonzero server PID")
	}
	caller, err := currentIdentity()
	if err != nil {
		return err
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, serverPID)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return err
	}
	defer token.Close()
	server, err := tokenIdentity(token, serverPID)
	if err != nil {
		return err
	}
	if caller.SID != server.SID || caller.SessionID != server.SessionID {
		return errors.New("runtime pipe server primary SID/session differs from helper caller")
	}
	logon, err := logonSID(token)
	if err != nil {
		return err
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	var pipe windows.Handle
	deadline := time.Now().Add(3 * time.Second)
	for {
		// Security-only handle, anonymous SQOS: never delegate caller authority.
		pipe, err = windows.CreateFile(p, windows.READ_CONTROL|windows.WRITE_DAC,
			0, nil, windows.OPEN_EXISTING, 0x00100000 /* SECURITY_SQOS_PRESENT | SECURITY_ANONYMOUS */, 0)
		if err == nil {
			break
		}
		if (!errors.Is(err, windows.ERROR_PIPE_BUSY) && !errors.Is(err, windows.ERROR_FILE_NOT_FOUND)) || time.Now().After(deadline) {
			return fmt.Errorf("open own runtime pipe security: %w", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer windows.CloseHandle(pipe)
	var actualPID uint32
	if err := windows.GetNamedPipeServerProcessId(pipe, &actualPID); err != nil {
		return err
	}
	if actualPID != serverPID {
		return errors.New("runtime pipe server PID differs from requested server")
	}
	sddl := "D:P(D;;GA;;;NU)(A;;GA;;;SY)(A;;GA;;;BA)"
	if caller.SID != "S-1-5-18" && caller.SID != "S-1-5-32-544" {
		sddl += "(A;;GA;;;" + caller.SID + ")"
	}
	if logon != "" && logon != caller.SID {
		sddl += "(A;;GA;;;" + logon + ")"
	}
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return err
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if err := windows.SetSecurityInfo(pipe, windows.SE_KERNEL_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, acl, nil); err != nil {
		return fmt.Errorf("restrict own runtime pipe ACL: %w", err)
	}
	ch := child{Info: childInfo{Identity: server}, logonSID: logon}
	if err := ch.validatePipeACL(pipe); err != nil {
		return err
	}
	state, err := windows.WaitForSingleObject(process, 0)
	if err != nil {
		return err
	}
	if state != uint32(windows.WAIT_TIMEOUT) {
		return errors.New("runtime server exited during pipe protection")
	}
	return nil
}
