package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codemowers/driftmower/desktop/dashboard"
)

func TestDesktopInstanceHelper(t *testing.T) {
	if os.Getenv("DRIFTMOWER_INSTANCE_TEST_HELPER") != "1" {
		return
	}
	if os.Getenv("DRIFTMOWER_INSTANCE_TEST_RESTART") == "1" {
		handled, err := controlDesktop(&dashboard.Config{Restart: true}, io.Discard)
		if err != nil || handled {
			t.Fatalf("restart: %v, %v", handled, err)
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	instance, err := recordInstance(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer removeInstance(instance)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	server := &http.Server{Handler: instanceHandler(http.NotFoundHandler(), instance, cancel), ReadHeaderTimeout: time.Second}
	go server.Serve(listener)
	<-ctx.Done()
	shutdown, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	if err := server.Shutdown(shutdown); err != nil {
		t.Fatal(err)
	}
}

func startInstanceHelper(t *testing.T, restart bool) (*exec.Cmd, *desktopInstance) {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^TestDesktopInstanceHelper$")
	command.Env = append(os.Environ(), "DRIFTMOWER_INSTANCE_TEST_HELPER=1", "DRIFTMOWER_INSTANCE_TEST_RESTART="+map[bool]string{true: "1", false: "0"}[restart])
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if command.ProcessState == nil {
			_ = command.Process.Kill()
			_ = command.Wait()
		}
	})
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		instance, err := readInstance()
		if err == nil && instance.PID == command.Process.Pid && probeInstance(instance) == nil {
			return command, instance
		}
		time.Sleep(20 * time.Millisecond)
	}
	_ = command.Process.Kill()
	_ = command.Wait()
	t.Fatal("instance did not start:", output.String())
	return nil, nil
}

func TestDesktopPIDStopAndRestart(t *testing.T) {
	t.Setenv("XDG_RUNTIME_DIR", t.TempDir())
	first, instance := startInstanceHelper(t, false)
	path, err := instancePath()
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("instance record permissions", err)
	}
	var output bytes.Buffer
	handled, err := controlDesktop(&dashboard.Config{PID: true}, &output)
	if err != nil || !handled || strings.TrimSpace(output.String()) != strconv.Itoa(first.Process.Pid) {
		t.Fatal("PID", output.String(), err)
	}
	output.Reset()
	handled, err = controlDesktop(&dashboard.Config{Status: true}, &output)
	if err != nil || !handled || !strings.Contains(output.String(), fmt.Sprint(instance.PID)) {
		t.Fatal("status", output.String(), err)
	}
	response, err := http.Post("http://"+instance.Address+"/api/desktop/stop", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode == http.StatusNoContent {
		t.Fatal("unauthenticated request stopped desktop")
	}
	if err := probeInstance(instance); err != nil {
		t.Fatal("unauthorized request affected instance", err)
	}
	second, replacement := startInstanceHelper(t, true)
	if err := first.Wait(); err != nil {
		t.Fatal("original process", err)
	}
	if replacement.PID == instance.PID {
		t.Fatal("restart retained original PID")
	}
	// Cleanup from an older process must preserve a replacement's record.
	removeInstance(instance)
	if current, err := readInstance(); err != nil || current.PID != replacement.PID {
		t.Fatal("replacement record removed", err)
	}
	handled, err = controlDesktop(&dashboard.Config{Stop: true}, io.Discard)
	if err != nil || !handled {
		t.Fatal("stop", err)
	}
	if err := second.Wait(); err != nil {
		t.Fatal("replacement process", err)
	}
	if _, err := readInstance(); !os.IsNotExist(err) {
		t.Fatal("stopped instance record remained", err)
	}
	handled, err = controlDesktop(&dashboard.Config{Stop: true}, io.Discard)
	if err != nil || !handled {
		t.Fatal("repeat stop", err)
	}
}
