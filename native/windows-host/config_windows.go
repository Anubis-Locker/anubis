package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	hostFile    = "anubis-host.exe"
	runtimeFile = "anubis.exe"
	adminSDDL   = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
)

var servicePattern = regexp.MustCompile(`^AnubisHost(?:-QA-[A-Za-z0-9-]{1,40})?$`)

type config struct {
	Version     int      `json:"version"`
	ServiceName string   `json:"serviceName"`
	InstallDir  string   `json:"installDir"`
	RuntimePath string   `json:"runtimeRelativePath"`
	AllowedSIDs []string `json:"allowedUserSids"`
}

func dataDir(name string) (string, error) {
	if !servicePattern.MatchString(name) {
		return "", errors.New("service name must be AnubisHost or AnubisHost-QA-<unique-suffix>")
	}
	root, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		return "", err
	}
	return filepath.Join(root, "Anubis", "Host", name), nil
}

func configPath(name string) (string, error) {
	root, err := dataDir(name)
	return filepath.Join(root, "host.json"), err
}

func descendant(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, `..\`) && !filepath.IsAbs(rel)
}

func trustedSID(sid string) bool {
	return sid == "S-1-5-18" || sid == "S-1-5-32-544" ||
		sid == "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" // TrustedInstaller.
}

// Fail closed on unusual ACLs instead of attempting to implement Windows AccessCheck.
func protectedPath(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("reparse point forbidden: %s", path)
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	attrs, err := windows.GetFileAttributes(p)
	if err != nil {
		return err
	}
	if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("reparse point forbidden: %s", path)
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	if owner == nil || !trustedSID(owner.String()) {
		return fmt.Errorf("untrusted owner: %s", path)
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if acl == nil {
		return fmt.Errorf("null DACL forbidden: %s", path)
	}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, i, &ace); err != nil {
			return err
		}
		if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
			continue
		}
		switch ace.Header.AceType {
		case windows.ACCESS_DENIED_ACE_TYPE:
			continue
		case windows.ACCESS_ALLOWED_ACE_TYPE:
			sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
			const writes = windows.GENERIC_ALL | windows.GENERIC_WRITE | windows.WRITE_DAC |
				windows.WRITE_OWNER | windows.DELETE | windows.FILE_WRITE_DATA |
				windows.FILE_APPEND_DATA | windows.FILE_WRITE_EA | windows.FILE_WRITE_ATTRIBUTES |
				0x40 // FILE_DELETE_CHILD.
			if ace.Mask&writes != 0 && !trustedSID(sid.String()) {
				return fmt.Errorf("untrusted write ACE for %s: %s", sid, path)
			}
		default:
			return fmt.Errorf("unsupported ACL entry type %d: %s", ace.Header.AceType, path)
		}
	}
	return nil
}

func protectedChain(root, path string) error {
	if !strings.EqualFold(root, path) && !descendant(root, path) {
		return errors.New("path escapes protected root")
	}
	for current := path; ; current = filepath.Dir(current) {
		if err := protectedPath(current); err != nil {
			return err
		}
		if strings.EqualFold(current, root) {
			return nil
		}
	}
}

func privatePath(path string) error {
	if err := protectedPath(path); err != nil {
		return err
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, index, &ace); err != nil {
			return err
		}
		if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE == 0 &&
			ace.Header.AceType == windows.ACCESS_ALLOWED_ACE_TYPE &&
			ace.Mask != 0 && !trustedSID((*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()) {
			return fmt.Errorf("machine data permits unrelated principals: %s", path)
		}
	}
	return nil
}

func privateChain(root, path string) error {
	if err := protectedChain(root, path); err != nil {
		return err
	}
	for current := path; ; current = filepath.Dir(current) {
		if err := privatePath(current); err != nil {
			return err
		}
		if strings.EqualFold(current, root) {
			return nil
		}
	}
}

func applyACL(path, sddl string) error {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return err
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
}

func secureMkdir(path string) error {
	if _, err := os.Lstat(path); err == nil {
		return privatePath(path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(adminSDDL)
	if err != nil {
		return err
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	sa := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	if err := windows.CreateDirectory(p, &sa); err != nil {
		return err
	}
	// An elevated installer may otherwise become the directory owner.
	admins, err := windows.StringToSid("S-1-5-32-544")
	if err != nil {
		return err
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION, admins, nil, nil, nil); err != nil {
		return err
	}
	return privatePath(path)
}

func (c config) validateInstall() error {
	if c.Version != 1 {
		return errors.New("unsupported config version")
	}
	if _, err := dataDir(c.ServiceName); err != nil {
		return err
	}
	programFiles, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil {
		return err
	}
	if !filepath.IsAbs(c.InstallDir) || filepath.Clean(c.InstallDir) != c.InstallDir ||
		!descendant(programFiles, c.InstallDir) || strings.Contains(c.InstallDir, ":") && strings.Count(c.InstallDir, ":") != 1 {
		return errors.New("installDir must be a canonical absolute directory below native Program Files")
	}
	if c.RuntimePath == "" || filepath.IsAbs(c.RuntimePath) || filepath.Clean(c.RuntimePath) != c.RuntimePath ||
		strings.ContainsAny(c.RuntimePath, ":/") || !descendant(c.InstallDir, filepath.Join(c.InstallDir, c.RuntimePath)) ||
		!strings.EqualFold(filepath.Ext(c.RuntimePath), ".exe") {
		return errors.New("runtimeRelativePath must be a canonical relative .exe path within installDir")
	}
	for _, file := range []string{hostFile, c.RuntimePath} {
		path := filepath.Join(c.InstallDir, file)
		if err := protectedChain(programFiles, path); err != nil {
			return fmt.Errorf("%s: %w", file, err)
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			return fmt.Errorf("required packaged executable is not a regular file: %s", file)
		}
	}
	if err := filepath.WalkDir(c.InstallDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		return protectedPath(path)
	}); err != nil {
		return fmt.Errorf("packaged install tree is not protected: %w", err)
	}
	for _, sid := range c.AllowedSIDs {
		parsed, err := windows.StringToSid(sid)
		if err != nil || parsed.String() != sid || !strings.HasPrefix(sid, "S-1-5-21-") {
			return fmt.Errorf("allowedUserSids must contain explicit canonical account SIDs: %s", sid)
		}
	}
	return nil
}

func (c config) validate() error {
	if err := c.validateInstall(); err != nil {
		return err
	}
	data, err := dataDir(c.ServiceName)
	if err != nil {
		return err
	}
	return privateChain(filepath.Dir(filepath.Dir(data)), data)
}

func loadConfig(name string) (config, error) {
	var c config
	path, err := configPath(name)
	if err != nil {
		return c, err
	}
	root, err := dataDir(name)
	if err != nil {
		return c, err
	}
	if err := privateChain(filepath.Dir(filepath.Dir(root)), path); err != nil {
		return c, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if len(raw) > 64*1024 {
		return c, errors.New("config exceeds 64 KiB")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&c); err != nil {
		return c, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return c, errors.New("trailing config content")
	}
	if c.ServiceName != name {
		return c, errors.New("config service name mismatch")
	}
	return c, c.validate()
}
