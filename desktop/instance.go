package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/codemowers/driftmower/desktop/dashboard"
)

type desktopInstance struct {
	PID        int       `json:"pid"`
	Address    string    `json:"address"`
	Started    time.Time `json:"started"`
	Executable string    `json:"executable"`
	Token      string    `json:"token"`
}

func instancePath() (string, error) {
	root := os.Getenv("XDG_RUNTIME_DIR")
	if root == "" {
		var err error
		root, err = os.UserCacheDir()
		if err != nil {
			return "", err
		}
	}
	return filepath.Join(root, "driftmower", "desktop.json"), nil
}

func readInstance() (*desktopInstance, error) {
	path, err := instancePath()
	if err != nil {
		return nil, err
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var instance desktopInstance
	if err := json.Unmarshal(body, &instance); err != nil {
		return nil, fmt.Errorf("invalid desktop record: %w", err)
	}
	host, port, err := net.SplitHostPort(instance.Address)
	number, parseErr := strconv.Atoi(port)
	if err != nil || parseErr != nil || host != "127.0.0.1" || number < 1 || number > 65535 || instance.PID <= 0 || len(instance.Token) != 64 || instance.Started.IsZero() {
		return nil, errors.New("invalid desktop record")
	}
	return &instance, nil
}

func recordInstance(address string) (*desktopInstance, error) {
	path, err := instancePath()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	instance := &desktopInstance{PID: os.Getpid(), Address: address, Started: time.Now().UTC(), Executable: executable, Token: hex.EncodeToString(secret)}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".desktop-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(temporary.Name())
	err = json.NewEncoder(temporary).Encode(instance)
	closeErr := temporary.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if err := os.Rename(temporary.Name(), path); err != nil {
		return nil, err
	}
	return instance, nil
}

func removeInstance(instance *desktopInstance) {
	current, err := readInstance()
	if err == nil && current.Token == instance.Token && current.PID == instance.PID {
		if path, err := instancePath(); err == nil {
			_ = os.Remove(path)
		}
	}
}

func instanceHandler(next http.Handler, instance *desktopInstance, stop func()) http.Handler {
	mux := http.NewServeMux()
	authorized := func(w http.ResponseWriter, r *http.Request) bool {
		w.Header().Set("Cache-Control", "no-store")
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+instance.Token)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return false
		}
		return true
	}
	mux.HandleFunc("GET /api/desktop/instance", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(w, r) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			PID     int       `json:"pid"`
			Started time.Time `json:"started"`
		}{instance.PID, instance.Started})
	})
	mux.HandleFunc("POST /api/desktop/stop", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(w, r) {
			return
		}
		defer stop()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.Handle("/", next)
	return mux
}

func requestInstance(instance *desktopInstance, method, path string) (*http.Response, error) {
	request, err := http.NewRequest(method, "http://"+instance.Address+path, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+instance.Token)
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusNoContent {
		response.Body.Close()
		return nil, fmt.Errorf("desktop control returned HTTP %d", response.StatusCode)
	}
	return response, nil
}

func probeInstance(instance *desktopInstance) error {
	response, err := requestInstance(instance, http.MethodGet, "/api/desktop/instance")
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var current struct {
		PID     int       `json:"pid"`
		Started time.Time `json:"started"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&current); err != nil {
		return err
	}
	if current.PID != instance.PID || !current.Started.Equal(instance.Started) {
		return errors.New("desktop process identity changed")
	}
	return nil
}

func stopInstance(instance *desktopInstance) error {
	response, err := requestInstance(instance, http.MethodPost, "/api/desktop/stop")
	if err != nil {
		return err
	}
	response.Body.Close()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		current, err := readInstance()
		if os.IsNotExist(err) || (err == nil && current.Token != instance.Token) {
			return nil
		}
		if err != nil {
			return err
		}
		time.Sleep(50 * time.Millisecond)
	}
	return errors.New("desktop did not finish shutting down")
}

func controlDesktop(cfg *dashboard.Config, output io.Writer) (bool, error) {
	count := 0
	for _, enabled := range []bool{cfg.Status, cfg.PID, cfg.Stop, cfg.Restart} {
		if enabled {
			count++
		}
	}
	if count == 0 {
		return false, nil
	}
	if count > 1 || cfg.InstallDesktop {
		return true, errors.New("use only one of --status, --pid, --stop, --restart or --install-desktop")
	}
	instance, err := readInstance()
	if err == nil {
		err = probeInstance(instance)
		if errors.Is(err, syscall.ECONNREFUSED) {
			removeInstance(instance)
			instance = nil
			err = os.ErrNotExist
		}
	}
	if os.IsNotExist(err) {
		if cfg.PID {
			return true, errors.New("desktop is not running")
		}
		if !cfg.Restart {
			fmt.Fprintln(output, "Desktop is not running")
		}
		return !cfg.Restart, nil
	}
	if err != nil {
		return true, fmt.Errorf("cannot contact desktop: %w", err)
	}
	if cfg.PID {
		fmt.Fprintln(output, instance.PID)
		return true, nil
	}
	if cfg.Status {
		path, _ := instancePath()
		fmt.Fprintf(output, "Desktop running: PID %d at http://%s\nState: %s\n", instance.PID, instance.Address, path)
		return true, nil
	}
	if err := stopInstance(instance); err != nil {
		return true, err
	}
	fmt.Fprintf(output, "Stopped desktop PID %d\n", instance.PID)
	return !cfg.Restart, nil
}
