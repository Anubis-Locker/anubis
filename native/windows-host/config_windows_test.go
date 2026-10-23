package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestServiceNames(t *testing.T) {
	for _, name := range []string{"AnubisHost", "AnubisHost-QA-one-123"} {
		if _, err := dataDir(name); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"", "OtherService", `AnubisHost\..\bad`, "AnubisHost-QA-", "AnubisHost-QA-" + string(make([]byte, 50))} {
		if _, err := dataDir(name); err == nil {
			t.Fatalf("accepted invalid service name %q", name)
		}
	}
}

func TestDescendant(t *testing.T) {
	for _, test := range []struct {
		path string
		want bool
	}{
		{`C:\Program Files\Anubis`, true},
		{`C:\PROGRAM FILES\Anubis\bin`, true},
		{`C:\Program Files`, false},
		{`C:\Program Files Evil\Anubis`, false},
		{`C:\Program Files\..\Users\Anubis`, false},
		{`D:\Program Files\Anubis`, false},
		{`\\server\Program Files\Anubis`, false},
	} {
		if got := descendant(`C:\Program Files`, test.path); got != test.want {
			t.Errorf("%q: got %v, want %v", test.path, got, test.want)
		}
	}
}

func TestRejectUserWritableInstallLocations(t *testing.T) {
	for _, path := range []string{os.TempDir(), `C:\Users\any\AppData\Local\Anubis`, `.\Anubis`, `\\server\Anubis`} {
		c := config{Version: 1, ServiceName: "AnubisHost-QA-Test", InstallDir: path, RuntimePath: runtimeFile}
		if err := c.validate(); err == nil {
			t.Fatalf("accepted install location %q", path)
		}
	}
}

func TestMachineDirectoryACL(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "AnubisHost-QA-private")
	if err := secureMkdir(dir); err != nil {
		t.Fatal(err)
	}
	if err := privatePath(dir); err != nil {
		t.Fatal(err)
	}
	if err := applyACL(dir, adminSDDL+"(A;OICI;GR;;;BU)"); err != nil {
		t.Fatal(err)
	}
	if err := protectedPath(dir); err != nil {
		t.Fatalf("read-only principals should not fail code protection: %v", err)
	}
	if err := privatePath(dir); err == nil {
		t.Fatal("machine data accepted unrelated readers")
	}
	if err := applyACL(dir, adminSDDL+"(A;OICI;GW;;;BU)"); err != nil {
		t.Fatal(err)
	}
	if err := protectedPath(dir); err == nil {
		t.Fatal("code protection accepted unrelated writers")
	}
}

func TestRejectReparsePoint(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := secureMkdir(target); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("cannot exercise reparse protection: %v", err)
	}
	if err := protectedPath(link); err == nil {
		t.Fatal("accepted a reparse point")
	}
}

func TestIdentityUsesWindowsToken(t *testing.T) {
	i, err := currentIdentity()
	if err != nil {
		t.Fatal(err)
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	if i.SID != user.User.Sid.String() || i.PID != windows.GetCurrentProcessId() || i.Account == "" {
		t.Fatalf("identity does not match native token: %+v", i)
	}
	t.Setenv("USERNAME", "FakeSYSTEM")
	t.Setenv("USERPROFILE", `C:\Windows\System32\config\systemprofile`)
	again, err := currentIdentity()
	if err != nil || again != i {
		t.Fatalf("environment changed reported identity: %+v, %v", again, err)
	}
	if i.SID != "S-1-5-18" && requireSystem() == nil {
		t.Fatal("non-SYSTEM caller accepted as SYSTEM")
	}
}

func TestIdentityCLISystemDirectoryIgnoresSpoofedEnvironment(t *testing.T) {
	expected, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(expected) || runtime.GOARCH == "amd64" && !strings.EqualFold(filepath.Base(expected), "System32") {
		t.Fatalf("unexpected native system directory: %q", expected)
	}
	t.Setenv("SystemRoot", filepath.Join(t.TempDir(), "spoofed-system-root"))
	t.Setenv("WINDIR", filepath.Join(t.TempDir(), "spoofed-windir"))
	t.Setenv("PATH", filepath.Join(t.TempDir(), "spoofed-path"))
	i, err := currentIdentity()
	if err != nil {
		t.Fatal(err)
	}
	rawIdentity, err := json.Marshal(i)
	if err != nil {
		t.Fatal(err)
	}
	var identityFields map[string]any
	if err := json.Unmarshal(rawIdentity, &identityFields); err != nil {
		t.Fatal(err)
	}
	if len(identityFields) != 5 || identityFields["systemDirectory"] != nil {
		t.Fatalf("shared broker/context identity schema changed: %s", rawIdentity)
	}
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	originalStdout := os.Stdout
	defer func() { os.Stdout = originalStdout }()
	os.Stdout = write
	commandErr := command([]string{"identity"})
	os.Stdout = originalStdout
	if closeErr := write.Close(); commandErr != nil || closeErr != nil {
		t.Fatalf("identity CLI failed: %v, %v", commandErr, closeErr)
	}
	rawCLI, err := io.ReadAll(read)
	if err != nil {
		t.Fatal(err)
	}
	var cliFields map[string]any
	if err := json.Unmarshal(rawCLI, &cliFields); err != nil {
		t.Fatal(err)
	}
	if cliFields["systemDirectory"] != expected {
		t.Fatalf("environment spoofed CLI system directory: %s; expected %q", rawCLI, expected)
	}
	delete(cliFields, "systemDirectory")
	if !reflect.DeepEqual(cliFields, identityFields) {
		t.Fatalf("CLI changed existing identity fields: %s", rawCLI)
	}
}
