package main

import (
	"errors"
	"regexp"
)

var accountSIDPattern = regexp.MustCompile(`^S-1-5-21-(?:[0-9]+-){3}[0-9]+$`)
var logonSIDPattern = regexp.MustCompile(`^S-1-5-5-[0-9]+-[0-9]+$`)
var contextIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

type authorizedSession struct {
	session
	LogonSID string `json:"logonSid"`
}

func matchingContext(ch *child, expected identity, logon string) bool {
	return logon != "" && ch.logonSID == logon && ch.Info.Identity.SID == expected.SID &&
		ch.Info.Identity.SessionID == expected.SessionID
}

func retainedContext(contexts map[string]*child, id string, expected identity, logon string) (*child, error) {
	ch := contexts[id]
	if ch == nil || !matchingContext(ch, expected, logon) {
		return nil, errors.New("selected context exited or belongs to a previous logon")
	}
	select {
	case <-ch.exit:
		return nil, errors.New("selected context exited")
	default:
		return ch, nil
	}
}

func (b *broker) contextPolicy() (config, error) {
	current, err := loadConfig(b.config.ServiceName)
	if err != nil {
		return current, err
	}
	if !samePath(current.InstallDir, b.config.InstallDir) || current.RuntimePath != b.config.RuntimePath {
		return current, errors.New("protected runtime configuration changed; restart required")
	}
	return current, nil
}

func (b *broker) listContexts() (any, error) {
	policy, err := b.contextPolicy()
	if err != nil {
		return nil, err
	}
	available, err := sessions()
	if err != nil {
		return nil, err
	}
	result := struct {
		Machine  *childInfo          `json:"machine"`
		Sessions []authorizedSession `json:"sessions"`
	}{Sessions: []authorizedSession{}}
	for _, candidate := range available {
		if candidate.Error != "" {
			continue
		}
		token, actual, err := primaryToken(&candidate.ID, policy.AllowedSIDs)
		if err != nil {
			continue
		}
		logon, logonErr := logonSID(token)
		token.Close()
		if logonErr != nil {
			return nil, logonErr
		}
		if logon == "" || actual.SID != candidate.SID || actual.SessionID != candidate.ID {
			continue
		}
		result.Sessions = append(result.Sessions, authorizedSession{
			session:  session{ID: candidate.ID, State: candidate.State, SID: actual.SID, Account: actual.Account},
			LogonSID: logon,
		})
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stopping {
		return nil, errors.New("service is stopping")
	}
	if b.machine != nil {
		select {
		case <-b.machine.exit:
		default:
			info := b.machine.Info
			info.Endpoint = nil
			result.Machine = &info
		}
	}
	return result, nil
}
