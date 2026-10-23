package main

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

type identity struct {
	SID       string `json:"sid"`
	Account   string `json:"account"`
	Elevated  bool   `json:"elevated"`
	SessionID uint32 `json:"sessionId"`
	PID       uint32 `json:"pid"`
}

func tokenIdentity(token windows.Token, pid uint32) (identity, error) {
	var result identity
	user, err := token.GetTokenUser()
	if err != nil {
		return result, err
	}
	result.SID = user.User.Sid.String()
	account, domain, _, err := user.User.Sid.LookupAccount("")
	if err != nil {
		return result, fmt.Errorf("LookupAccount: %w", err)
	}
	result.Account = domain + `\` + account
	result.PID = pid
	var needed uint32
	var elevated uint32
	if err := windows.GetTokenInformation(token, windows.TokenElevation,
		(*byte)(unsafe.Pointer(&elevated)), uint32(unsafe.Sizeof(elevated)), &needed); err != nil {
		return result, err
	}
	result.Elevated = elevated != 0
	if err := windows.GetTokenInformation(token, windows.TokenSessionId,
		(*byte)(unsafe.Pointer(&result.SessionID)), uint32(unsafe.Sizeof(result.SessionID)), &needed); err != nil {
		return result, err
	}
	return result, nil
}

func currentIdentity() (identity, error) {
	return tokenIdentity(windows.GetCurrentProcessToken(), windows.GetCurrentProcessId())
}

func requireSystem() error {
	i, err := currentIdentity()
	if err != nil {
		return err
	}
	if i.SID != "S-1-5-18" || i.SessionID != 0 {
		return fmt.Errorf("requires actual LocalSystem token in session 0, got %s session %d", i.SID, i.SessionID)
	}
	return nil
}

type session struct {
	ID      uint32 `json:"id"`
	State   uint32 `json:"state"`
	SID     string `json:"sid,omitempty"`
	Account string `json:"account,omitempty"`
	Error   string `json:"error,omitempty"`
}

func sessions() ([]session, error) {
	var entries *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &entries, &count); err != nil {
		return nil, err
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(entries)))
	result := make([]session, 0, count)
	for _, entry := range unsafe.Slice(entries, count) {
		// Active and disconnected sessions can both own a logged-on user.
		if entry.State != 0 && entry.State != 4 {
			continue
		}
		var token windows.Token
		s := session{ID: entry.SessionID, State: entry.State}
		if err := windows.WTSQueryUserToken(entry.SessionID, &token); err != nil {
			s.Error = err.Error()
		} else {
			i, err := tokenIdentity(token, 0)
			token.Close()
			if err != nil {
				s.Error = err.Error()
			} else {
				s.SID, s.Account = i.SID, i.Account
			}
		}
		result = append(result, s)
	}
	return result, nil
}
