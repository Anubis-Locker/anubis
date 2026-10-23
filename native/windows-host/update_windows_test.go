package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

func updateFixture(t *testing.T) (updateRequest, string, []byte) {
	t.Helper()
	dir := t.TempDir()
	root := filepath.Join(dir, "private")
	if err := createUpdateDirectory(root); err != nil {
		t.Fatal(err)
	}
	payload := append([]byte("MZ"), bytes.Repeat([]byte("owned-update-fixture"), 4000)...)
	source := filepath.Join(dir, "download.exe")
	if err := os.WriteFile(source, payload, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	return updateRequest{
		Name: "AnubisHost-QA-Update", SourceFile: source,
		Size: int64(len(payload)), SHA256: hex.EncodeToString(digest[:]),
	}, root, payload
}

func TestUpdateRequestValidation(t *testing.T) {
	r := updateRequest{Name: "AnubisHost", SourceFile: `C:\Users\person\download.exe`, SHA256: strings.Repeat("a", 64), Size: 123}
	if err := r.validate(); err != nil {
		t.Fatal(err)
	}
	for _, size := range []int64{-1, 0, maxUpdateSize + 1} {
		invalid := r
		invalid.Size = size
		if invalid.validate() == nil {
			t.Fatalf("accepted size %d", size)
		}
	}
	for _, hash := range []string{"", strings.Repeat("a", 63), strings.Repeat("g", 64), strings.Repeat("a", 66)} {
		invalid := r
		invalid.SHA256 = hash
		if invalid.validate() == nil {
			t.Fatalf("accepted hash %q", hash)
		}
	}
	for _, path := range []string{
		`download.exe`, `C:download.exe`, `\\server\share\download.exe`,
		`\\.\pipe\download.exe`, `\\?\C:\temp\download.exe`,
		`C:\temp\download.exe:stream`, `C:\temp\..\download.exe`,
		`C:\temp\download.exe.`, `C:\temp \download.exe`, `C:/temp/download.exe`,
		`C:\temp\NUL.exe`, `C:\temp\COM1.exe`, "C:\\temp\\LPT\u00b9.exe",
		`C:\temp\CONIN$.exe`, `C:\temp\COM1 .exe`, `C:\temp\download.txt`,
		"C:\\temp\\line\nbreak.exe",
	} {
		invalid := r
		invalid.SourceFile = path
		if invalid.validate() == nil {
			t.Fatalf("accepted source %q", path)
		}
	}
}

func TestUpdateStagesVerifiedBytesWithAtomicOwnerAndACL(t *testing.T) {
	r, root, payload := updateFixture(t)
	r.SHA256 = strings.ToUpper(r.SHA256)
	staged, err := stageUpdate(r, root)
	if err != nil {
		t.Fatal(err)
	}
	if staged.Size != r.Size || staged.SHA256 != strings.ToLower(r.SHA256) ||
		filepath.Base(staged.Path) != "installer.exe" || !descendant(filepath.Join(root, "updates"), staged.Path) {
		t.Fatalf("unexpected result: %+v", staged)
	}
	for _, path := range []string{filepath.Join(root, "updates"), filepath.Dir(staged.Path), staged.Path} {
		if err := updatePathSecurity(path); err != nil {
			t.Fatalf("actual owner/ACL is not protected: %s: %v", path, err)
		}
	}
	if err := os.WriteFile(r.SourceFile, []byte("untrusted temp rewritten after copy"), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(staged.Path)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("protected installer changed with source: %v", err)
	}
	entries, err := os.ReadDir(filepath.Dir(staged.Path))
	if err != nil || len(entries) != 1 || entries[0].Name() != "installer.exe" {
		t.Fatalf("partial/unexpected artifacts: %+v %v", entries, err)
	}
}

func TestUpdateMismatchCleansOnlyFreshLeaf(t *testing.T) {
	r, root, payload := updateFixture(t)
	staged, err := stageUpdate(r, root)
	if err != nil {
		t.Fatal(err)
	}
	bad := r
	bad.SHA256 = strings.Repeat("0", 64)
	result, err := stageUpdate(bad, root)
	if err == nil || result != (preparedUpdate{}) {
		t.Fatalf("mismatching copy was accepted: %+v %v", result, err)
	}
	entries, err := os.ReadDir(filepath.Join(root, "updates"))
	if err != nil || len(entries) != 1 || entries[0].Name() != filepath.Base(filepath.Dir(staged.Path)) {
		t.Fatalf("failed copy left artifacts or removed another update: %+v %v", entries, err)
	}
	got, err := os.ReadFile(staged.Path)
	if err != nil || !bytes.Equal(got, payload) {
		t.Fatalf("successful fixture changed during failed cleanup: %v", err)
	}
}

func TestUpdateUsesUniqueLeavesAndLocksSourceDuringCopy(t *testing.T) {
	r, root, _ := updateFixture(t)
	first, err := stageUpdate(r, root)
	if err != nil {
		t.Fatal(err)
	}
	second, err := stageUpdate(r, root)
	if err != nil || first.Path == second.Path {
		t.Fatalf("update reused another launch's leaf: %v", err)
	}
	source, err := openUpdateSource(r)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	writer, err := os.OpenFile(r.SourceFile, os.O_WRONLY, 0600)
	if err == nil {
		writer.Close()
		t.Fatal("source could be rewritten while its verified handle was retained")
	}
	if !errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		t.Fatal(err)
	}
	if err := os.Rename(r.SourceFile, r.SourceFile+".moved"); !errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
		t.Fatalf("source could be replaced while retained: %v", err)
	}
}

func TestUpdateRejectsSizeLinksAndExistingWriter(t *testing.T) {
	t.Run("size", func(t *testing.T) {
		r, root, _ := updateFixture(t)
		r.Size++
		if _, err := stageUpdate(r, root); err == nil {
			t.Fatal("accepted incomplete source")
		}
	})
	t.Run("hardlink", func(t *testing.T) {
		r, root, _ := updateFixture(t)
		if err := os.Link(r.SourceFile, filepath.Join(filepath.Dir(r.SourceFile), "second.exe")); err != nil {
			t.Fatal(err)
		}
		if _, err := stageUpdate(r, root); err == nil {
			t.Fatal("accepted multiply-linked source")
		}
	})
	t.Run("directory", func(t *testing.T) {
		r, root, _ := updateFixture(t)
		r.SourceFile = filepath.Join(filepath.Dir(r.SourceFile), "directory.exe")
		if err := os.Mkdir(r.SourceFile, 0700); err != nil {
			t.Fatal(err)
		}
		if _, err := stageUpdate(r, root); err == nil {
			t.Fatal("accepted directory as installer")
		}
	})
	t.Run("source-reparse", func(t *testing.T) {
		r, root, _ := updateFixture(t)
		link := filepath.Join(filepath.Dir(r.SourceFile), "link.exe")
		if err := os.Symlink(r.SourceFile, link); err != nil {
			t.Fatal(err)
		}
		r.SourceFile = link
		if _, err := stageUpdate(r, root); err == nil {
			t.Fatal("followed source symlink")
		}
	})
	t.Run("ancestor-reparse", func(t *testing.T) {
		r, root, _ := updateFixture(t)
		link := filepath.Join(t.TempDir(), "junction")
		if err := os.Symlink(filepath.Dir(r.SourceFile), link); err != nil {
			t.Fatal(err)
		}
		r.SourceFile = filepath.Join(link, filepath.Base(r.SourceFile))
		if _, err := stageUpdate(r, root); err == nil {
			t.Fatal("followed source ancestor reparse point")
		}
	})
	t.Run("existing-writer", func(t *testing.T) {
		r, root, _ := updateFixture(t)
		writer, err := os.OpenFile(r.SourceFile, os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		defer writer.Close()
		if _, err := stageUpdate(r, root); !errors.Is(err, windows.ERROR_SHARING_VIOLATION) {
			t.Fatalf("accepted an already-open source writer: %v", err)
		}
	})
}

func TestUpdateRejectsUntrustedOrReparseDestination(t *testing.T) {
	t.Run("untrusted-ACE", func(t *testing.T) {
		r, root, _ := updateFixture(t)
		dir := filepath.Join(root, "updates")
		if err := createUpdateDirectory(dir); err != nil {
			t.Fatal(err)
		}
		i, err := currentIdentity()
		if err != nil {
			t.Fatal(err)
		}
		if err := applyACL(dir, adminSDDL+"(A;OICI;FA;;;"+i.SID+")"); err != nil {
			t.Fatal(err)
		}
		if _, err := stageUpdate(r, root); err == nil {
			t.Fatal("accepted individual-user writable update parent")
		}
	})
	t.Run("reparse", func(t *testing.T) {
		r, root, _ := updateFixture(t)
		target := t.TempDir()
		if err := os.WriteFile(filepath.Join(target, "keep.txt"), []byte("owned-fixture"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, filepath.Join(root, "updates")); err != nil {
			t.Fatal(err)
		}
		if _, err := stageUpdate(r, root); err == nil {
			t.Fatal("followed destination reparse point")
		}
		entries, err := os.ReadDir(target)
		if err != nil || len(entries) != 1 || entries[0].Name() != "keep.txt" {
			t.Fatalf("modified reparse target: %+v %v", entries, err)
		}
	})
}

func TestUpdateRestrictedSameUserCannotPrepareOrRewrite(t *testing.T) {
	r, root, _ := updateFixture(t)
	staged, err := stageUpdate(r, root)
	if err != nil {
		t.Fatal(err)
	}
	token := restrictedAdminToken(t)
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := windows.SetThreadToken(nil, token); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := windows.RevertToSelf(); err != nil {
			panic("QA RevertToSelf failed")
		}
	}()
	if requireUpdateAdmin() == nil {
		t.Fatal("restricted administrator accepted for prepare-update")
	}
	p, err := windows.UTF16PtrFromString(staged.Path)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(p, windows.GENERIC_WRITE|windows.WRITE_DAC, windows.FILE_SHARE_READ,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err == nil {
		windows.CloseHandle(handle)
		t.Fatal("same-account restricted token rewrote staged installer or its ACL")
	}
	if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("expected kernel ACL denial, got %v", err)
	}
}

func TestUpdateServiceIdentityValidation(t *testing.T) {
	c := config{ServiceName: "AnubisHost-QA-Update", InstallDir: `C:\Program Files\Anubis`}
	valid := mgr.Config{
		BinaryPathName:   windows.ComposeCommandLine([]string{filepath.Join(c.InstallDir, hostFile), "service", "--name", c.ServiceName}),
		ServiceStartName: "LocalSystem", ServiceType: windows.SERVICE_WIN32_OWN_PROCESS,
	}
	if err := validateUpdateService(c, valid); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*mgr.Config){
		func(sc *mgr.Config) {
			sc.BinaryPathName = `C:\Users\person\bad.exe service --name AnubisHost-QA-Update`
		},
		func(sc *mgr.Config) { sc.BinaryPathName += " --extra" },
		func(sc *mgr.Config) {
			sc.BinaryPathName = strings.ReplaceAll(sc.BinaryPathName, c.ServiceName, "AnubisHost")
		},
		func(sc *mgr.Config) { sc.ServiceStartName = "LocalService" },
		func(sc *mgr.Config) { sc.ServiceType = windows.SERVICE_WIN32_SHARE_PROCESS },
	} {
		invalid := valid
		change(&invalid)
		if validateUpdateService(c, invalid) == nil {
			t.Fatalf("accepted wrong registered service: %+v", invalid)
		}
	}
}

func copyProtectedFixture(t *testing.T, source, destination string) {
	t.Helper()
	in, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	out, err := createUpdateFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateInstalledOrchestrationMocksOnlyServiceQuery(t *testing.T) {
	id, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	name := "AnubisHost-QA-Update-" + id[:24]
	programFiles, err := windows.KnownFolderPath(windows.FOLDERID_ProgramFiles, 0)
	if err != nil {
		t.Fatal(err)
	}
	installDir := filepath.Join(programFiles, name)
	if err := createUpdateDirectory(installDir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(installDir); err != nil {
			t.Error(err)
		}
	})
	root, err := dataDir(name)
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{filepath.Dir(filepath.Dir(root)), filepath.Dir(root)} {
		if _, err := os.Lstat(dir); errors.Is(err, os.ErrNotExist) {
			if err := createUpdateDirectory(dir); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.Remove(dir); err != nil {
					t.Error(err)
				}
			})
		} else if err != nil {
			t.Fatal(err)
		} else if err := privatePath(dir); err != nil {
			t.Fatal(err)
		}
	}
	if err := createUpdateDirectory(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	testExe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	copyProtectedFixture(t, testExe, filepath.Join(installDir, hostFile))
	copyProtectedFixture(t, testExe, filepath.Join(installDir, runtimeFile))
	c := config{Version: 1, ServiceName: name, InstallDir: installDir, RuntimePath: runtimeFile}
	configFile, err := createUpdateFile(filepath.Join(root, "host.json"))
	if err != nil {
		t.Fatal(err)
	}
	encodeErr := json.NewEncoder(configFile).Encode(c)
	if err := errors.Join(encodeErr, configFile.Close()); err != nil {
		t.Fatal(err)
	}
	r, _, _ := updateFixture(t)
	r.Name = name
	queryCalled := false
	if _, err := prepareUpdateWithServiceQuery(r, func(string) (mgr.Config, error) {
		queryCalled = true
		return mgr.Config{}, nil
	}); err == nil || queryCalled {
		t.Fatalf("uninstalled current test executable passed helper-image verification: %v", err)
	}
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(filepath.Join(installDir, hostFile), "-test.run=^TestUpdateInstalledHelper$", "--", "anubis-qa-update-installed")
	cmd.Stdin = bytes.NewReader(raw)
	output, err := cmd.CombinedOutput()
	if err != nil || !bytes.Contains(output, []byte("PASS")) {
		t.Fatalf("real protected orchestration failed: %v\n%s", err, output)
	}
}

// Only the SCM query is substituted; config, executable, copy, owner, ACL and hash use real WinAPI.
func TestUpdateInstalledHelper(t *testing.T) {
	if len(os.Args) < 2 || os.Args[len(os.Args)-1] != "anubis-qa-update-installed" {
		return
	}
	var r updateRequest
	if err := json.NewDecoder(os.Stdin).Decode(&r); err != nil {
		t.Fatal(err)
	}
	c, err := loadConfig(r.Name)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	query := func(name string) (mgr.Config, error) {
		calls++
		if name != r.Name {
			t.Fatalf("queried wrong service %s", name)
		}
		return mgr.Config{
			BinaryPathName:   windows.ComposeCommandLine([]string{filepath.Join(c.InstallDir, hostFile), "service", "--name", name}),
			ServiceStartName: "LocalSystem", ServiceType: windows.SERVICE_WIN32_OWN_PROCESS,
		}, nil
	}
	result, err := prepareUpdateWithServiceQuery(r, query)
	if err != nil || calls != 1 {
		t.Fatalf("prepare-update failed: %+v %v calls=%d", result, err, calls)
	}
	if err := updatePathSecurity(result.Path); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareUpdateWithServiceQuery(r, func(string) (mgr.Config, error) {
		return mgr.Config{}, windows.ERROR_SERVICE_DOES_NOT_EXIST
	}); err == nil {
		t.Fatal("accepted an unregistered service")
	}
}
