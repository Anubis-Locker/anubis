package main

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func TestOwnNodePipeProtectionSurvivesNewInstances(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node runtime integration test requires node on PATH")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	id, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	path := `\\.\pipe\AnubisHost-QA-Node-context-` + id
	script := `const net=require('node:net'); const s=net.createServer(c=>{c.on('error',()=>{}); c.resume()}); s.listen(process.argv[1],()=>console.log(process.pid));`
	cmd := exec.CommandContext(ctx, node, "-e", script, path)
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cmd.Process.Kill()
		cmd.Wait()
	}()
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.ParseUint(strings.TrimSpace(line), 10, 32)
	if err != nil || pid != uint64(cmd.Process.Pid) {
		t.Fatalf("wrong actual Node PID: %q %v", line, err)
	}
	if err := secureRuntimePipe(path, uint32(os.Getpid())); err == nil {
		t.Fatal("protected pipe using a different requested server PID")
	}
	if err := secureRuntimePipe(path, uint32(pid)); err != nil {
		t.Fatal(err)
	}
	i, err := currentIdentity()
	if err != nil {
		t.Fatal(err)
	}
	logon, err := logonSID(windows.GetCurrentProcessToken())
	if err != nil {
		t.Fatal(err)
	}
	ch := child{Info: childInfo{Identity: i}, logonSID: logon}
	for index := 0; index < 4; index++ {
		conn, err := winio.DialPipeContext(ctx, path)
		if err != nil {
			t.Fatal(err)
		}
		fd := conn.(interface{ Fd() uintptr })
		var actual uint32
		err = windows.GetNamedPipeServerProcessId(windows.Handle(fd.Fd()), &actual)
		if err == nil {
			err = ch.validatePipeACL(windows.Handle(fd.Fd()))
		}
		conn.Close()
		if err != nil || actual != uint32(pid) {
			t.Fatalf("subsequent Node pipe instance %d lost required ACL/PID: %v pid=%d", index, err, actual)
		}
	}
}

func TestOwnPipeProtectionRejectsOtherNames(t *testing.T) {
	for _, path := range []string{
		`\\server\pipe\AnubisHost-context-0123456789abcdef0123456789abcdef`,
		`\\.\pipe\UnrelatedApplication`,
		`C:\ProgramData\pipe`,
		`\\.\pipe\AnubisHost-context-not-an-id`,
	} {
		if err := secureRuntimePipe(path, windows.GetCurrentProcessId()); err == nil {
			t.Fatalf("accepted unrelated pipe %q", path)
		}
	}
}
