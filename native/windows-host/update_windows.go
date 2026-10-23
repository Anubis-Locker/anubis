package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

const updateSDDL = "O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
const maxUpdateSize int64 = 2 * 1024 * 1024 * 1024

type updateRequest struct {
	Name       string
	SourceFile string
	SHA256     string
	Size       int64
}

type preparedUpdate struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

func (r updateRequest) validate() error {
	if !servicePattern.MatchString(r.Name) {
		return errors.New("invalid service name")
	}
	digest, err := hex.DecodeString(r.SHA256)
	if err != nil || len(r.SHA256) != 64 || len(digest) != sha256.Size {
		return errors.New("sha256 must contain exactly 64 hexadecimal characters")
	}
	if r.Size < 1 || r.Size > maxUpdateSize {
		return errors.New("size must be positive and at most 2147483648 bytes")
	}
	if !strings.EqualFold(filepath.Ext(r.SourceFile), ".exe") {
		return errors.New("source-file must be a local regular .exe file")
	}
	return localPathSyntax(r.SourceFile)
}

func requireUpdateAdmin() error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	var token windows.Token
	err := windows.OpenThreadToken(windows.CurrentThread(), windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, true, &token)
	if errors.Is(err, windows.ERROR_NO_TOKEN) {
		err = windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE, &token)
	}
	if err != nil {
		return err
	}
	defer token.Close()
	i, err := tokenIdentity(token, 0)
	if err != nil {
		return err
	}
	restricted, err := token.IsRestricted()
	if err != nil {
		return err
	}
	if !i.Elevated || restricted {
		return errors.New("prepare-update requires an unrestricted elevated administrator")
	}
	var membershipToken windows.Token
	if err := windows.DuplicateTokenEx(token, windows.TOKEN_QUERY, nil,
		windows.SecurityIdentification, windows.TokenImpersonation, &membershipToken); err != nil {
		return err
	}
	defer membershipToken.Close()
	admins, err := windows.StringToSid("S-1-5-32-544")
	if err != nil {
		return err
	}
	member, err := membershipToken.IsMember(admins)
	if err != nil {
		return err
	}
	if !member {
		return errors.New("prepare-update requires effective Administrators membership")
	}
	return nil
}

func queryUpdateService(name string) (mgr.Config, error) {
	manager, err := mgr.Connect()
	if err != nil {
		return mgr.Config{}, err
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(name)
	if err != nil {
		return mgr.Config{}, err
	}
	defer service.Close()
	return service.Config()
}

func validateUpdateService(c config, sc mgr.Config) error {
	args, err := windows.DecomposeCommandLine(sc.BinaryPathName)
	if err != nil || len(args) != 4 || !samePath(args[0], filepath.Join(c.InstallDir, hostFile)) ||
		args[1] != "service" || args[2] != "--name" || args[3] != c.ServiceName ||
		(!strings.EqualFold(sc.ServiceStartName, "LocalSystem") &&
			!strings.EqualFold(sc.ServiceStartName, `NT AUTHORITY\SYSTEM`)) ||
		sc.ServiceType != windows.SERVICE_WIN32_OWN_PROCESS {
		return errors.New("registered service image, arguments, type, or account does not match protected host config")
	}
	return nil
}

func prepareUpdate(r updateRequest) (preparedUpdate, error) {
	return prepareUpdateWithServiceQuery(r, queryUpdateService)
}

func prepareUpdateWithServiceQuery(r updateRequest, query func(string) (mgr.Config, error)) (preparedUpdate, error) {
	if err := r.validate(); err != nil {
		return preparedUpdate{}, err
	}
	if err := requireUpdateAdmin(); err != nil {
		return preparedUpdate{}, err
	}
	c, err := loadConfig(r.Name)
	if err != nil {
		return preparedUpdate{}, err
	}
	exe, err := os.Executable()
	if err != nil {
		return preparedUpdate{}, err
	}
	if !samePath(exe, filepath.Join(c.InstallDir, hostFile)) {
		return preparedUpdate{}, errors.New("prepare-update must run the protected installed helper")
	}
	sc, err := query(r.Name)
	if err != nil {
		return preparedUpdate{}, fmt.Errorf("verify registered service: %w", err)
	}
	if err := validateUpdateService(c, sc); err != nil {
		return preparedUpdate{}, err
	}
	root, err := dataDir(r.Name)
	if err != nil {
		return preparedUpdate{}, err
	}
	return stageUpdate(r, root)
}

func localPathSyntax(path string) error {
	if len(path) < 4 || !((path[0] >= 'A' && path[0] <= 'Z') || (path[0] >= 'a' && path[0] <= 'z')) ||
		path[1:3] != `:\` || filepath.Clean(path) != path || strings.ContainsAny(path[2:], ":/") ||
		strings.ContainsAny(path, "\x00*?<>|\"") {
		return errors.New("requires a canonical absolute drive path; UNC, devices, streams, and relative paths are forbidden")
	}
	for _, character := range path {
		if character < 32 || character == 127 {
			return errors.New("control characters are forbidden in update paths")
		}
	}
	for _, part := range strings.Split(path[3:], `\`) {
		if part == "" || strings.TrimRight(part, " .") != part {
			return errors.New("empty or trailing-dot/space path component is forbidden")
		}
		base := strings.TrimRight(strings.ToUpper(strings.SplitN(part, ".", 2)[0]), " ")
		if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" ||
			base == "CONIN$" || base == "CONOUT$" || base == "CLOCK$" {
			return errors.New("DOS device path component is forbidden")
		}
		if strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT") {
			suffix := base[3:]
			if len(suffix) == 1 && suffix[0] >= '1' && suffix[0] <= '9' ||
				suffix == "\u00b9" || suffix == "\u00b2" || suffix == "\u00b3" {
				return errors.New("DOS device path component is forbidden")
			}
		}
	}
	return nil
}

func localNonReparsePath(path string) error {
	if err := localPathSyntax(path); err != nil {
		return err
	}
	drive, err := windows.UTF16PtrFromString(path[:3])
	if err != nil {
		return err
	}
	kind := windows.GetDriveType(drive)
	if kind != windows.DRIVE_FIXED && kind != windows.DRIVE_REMOVABLE {
		return errors.New("requires a local fixed or removable drive")
	}
	for current := path; ; current = filepath.Dir(current) {
		p, err := windows.UTF16PtrFromString(current)
		if err != nil {
			return err
		}
		attrs, err := windows.GetFileAttributes(p)
		if err != nil {
			return err
		}
		if attrs&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("reparse points are forbidden in update paths")
		}
		if len(current) == 3 {
			return nil
		}
	}
}

func finalHandlePath(handle windows.Handle) (string, error) {
	buffer := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
	if err != nil {
		return "", err
	}
	if n == 0 || n >= uint32(len(buffer)) {
		return "", errors.New("unexpected final file path length")
	}
	path := windows.UTF16ToString(buffer[:n])
	if !strings.HasPrefix(path, `\\?\`) {
		return "", errors.New("unexpected final file path namespace")
	}
	return strings.TrimPrefix(path, `\\?\`), nil
}

func openUpdateSource(r updateRequest) (*os.File, error) {
	if err := localNonReparsePath(r.SourceFile); err != nil {
		return nil, err
	}
	p, err := windows.UTF16PtrFromString(r.SourceFile)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(p, windows.GENERIC_READ, windows.FILE_SHARE_READ,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_SEQUENTIAL_SCAN, 0)
	if err != nil {
		return nil, fmt.Errorf("open stable update source: %w", err)
	}
	file := os.NewFile(uintptr(handle), r.SourceFile)
	fail := func(err error) (*os.File, error) {
		return nil, errors.Join(err, file.Close())
	}
	kind, err := windows.GetFileType(handle)
	if err != nil || kind != windows.FILE_TYPE_DISK {
		return fail(errors.Join(errors.New("source is not a disk file"), err))
	}
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return fail(err)
	}
	size := int64(uint64(info.FileSizeHigh)<<32 | uint64(info.FileSizeLow))
	if info.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT) != 0 ||
		info.NumberOfLinks != 1 || size != r.Size {
		return fail(errors.New("source must be a single-link regular file with the exact expected size"))
	}
	resolved, err := finalHandlePath(handle)
	if err != nil {
		return fail(err)
	}
	if !samePath(resolved, r.SourceFile) {
		return fail(errors.New("opened source resolves to a different path"))
	}
	if err := localNonReparsePath(resolved); err != nil {
		return fail(err)
	}
	return file, nil
}

func updateAttributes() (*windows.SecurityAttributes, error) {
	sd, err := windows.SecurityDescriptorFromString(updateSDDL)
	if err != nil {
		return nil, err
	}
	return &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}, nil
}

func createUpdateDirectory(path string) error {
	sa, err := updateAttributes()
	if err != nil {
		return err
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	return windows.CreateDirectory(p, sa)
}

func createUpdateFile(path string) (*os.File, error) {
	sa, err := updateAttributes()
	if err != nil {
		return nil, err
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateFile(p, windows.GENERIC_READ|windows.GENERIC_WRITE, 0,
		sa, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(handle), path), nil
}

func updatePathSecurity(path string) error {
	if err := privatePath(path); err != nil {
		return err
	}
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	control, _, err := sd.Control()
	if err != nil {
		return err
	}
	if owner.String() != "S-1-5-32-544" || uint16(control)&0x1000 == 0 {
		return errors.New("update destination must have Administrators ownership and a protected DACL")
	}
	acl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	found := map[string]bool{}
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, index, &ace); err != nil {
			return err
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE ||
			ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 {
			return errors.New("update destination requires only effective allow ACEs")
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		if sid != "S-1-5-18" && sid != "S-1-5-32-544" {
			return errors.New("update destination must allow only SYSTEM and Administrators")
		}
		const fileAllAccess = 0x001f01ff
		if ace.Mask&windows.GENERIC_ALL == 0 && ace.Mask&fileAllAccess != fileAllAccess {
			return errors.New("update destination lacks full trusted access")
		}
		found[sid] = true
	}
	if !found["S-1-5-18"] || !found["S-1-5-32-544"] {
		return errors.New("update destination lacks required trusted principals")
	}
	return nil
}

func stageUpdate(r updateRequest, root string) (result preparedUpdate, err error) {
	if err := r.validate(); err != nil {
		return result, err
	}
	if err := localNonReparsePath(root); err != nil {
		return result, err
	}
	if err := privatePath(root); err != nil {
		return result, err
	}
	source, err := openUpdateSource(r)
	if err != nil {
		return result, err
	}
	defer func() {
		if source != nil {
			err = errors.Join(err, source.Close())
		}
	}()
	updates := filepath.Join(root, "updates")
	if err := createUpdateDirectory(updates); err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return result, err
	}
	if err := updatePathSecurity(updates); err != nil {
		return result, err
	}
	id, err := randomID()
	if err != nil {
		return result, err
	}
	dir := filepath.Join(updates, id)
	if err := createUpdateDirectory(dir); err != nil {
		return result, err
	}
	current := filepath.Join(dir, "installer.partial")
	createdFile := false
	defer func() {
		if err != nil {
			if createdFile {
				err = errors.Join(err, os.Remove(current))
			}
			err = errors.Join(err, os.Remove(dir))
			result = preparedUpdate{}
		}
	}()
	if err := updatePathSecurity(dir); err != nil {
		return result, err
	}
	destination, err := createUpdateFile(current)
	if err != nil {
		return result, err
	}
	createdFile = true
	hash := sha256.New()
	count, copyErr := io.CopyBuffer(io.MultiWriter(destination, hash), io.LimitReader(source, r.Size+1), make([]byte, 64*1024))
	sourceCloseErr := source.Close()
	source = nil
	syncErr := destination.Sync()
	closeErr := destination.Close()
	if err := errors.Join(copyErr, sourceCloseErr, syncErr, closeErr); err != nil {
		return result, err
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if count != r.Size || !strings.EqualFold(actual, r.SHA256) {
		return result, errors.New("copied installer SHA256 or byte size mismatch")
	}
	if err := updatePathSecurity(current); err != nil {
		return result, err
	}
	final := filepath.Join(dir, "installer.exe")
	from, err := windows.UTF16PtrFromString(current)
	if err != nil {
		return result, err
	}
	to, err := windows.UTF16PtrFromString(final)
	if err != nil {
		return result, err
	}
	if err := windows.MoveFileEx(from, to, windows.MOVEFILE_WRITE_THROUGH); err != nil {
		return result, err
	}
	current = final
	if err := updatePathSecurity(final); err != nil {
		return result, err
	}
	return preparedUpdate{Path: final, Size: count, SHA256: actual}, nil
}
