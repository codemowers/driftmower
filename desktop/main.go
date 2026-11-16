// driftmower-desktop runs the dashboard on this machine and opens it as a
// Google Chrome application window, falling back to Chromium. Unlike the
// server image it may run kubelogin, so Settings can sign in to a context.
//
// Chrome runs with the person's own profile, so their passkeys and password
// manager work for MCP sign-in. Chrome hands the window to its running
// instance and the launch returns at once, so this process exits when the
// page has stopped polling for a while instead of when the window closes.
package main

import (
	"context"
	"errors"
	"flag"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/codemowers/driftmower/desktop/dashboard"
)

const (
	// MCP servers allow this origin (mcp.dashboard.localOrigins) and its
	// /callback as a loopback redirect, so the port is fixed.
	listenAddr = dashboard.DesktopAddress
	// Chrome throttles timers in hidden windows to once a minute.
	idleAfter = 5 * time.Minute
)

func main() {
	if os.Getenv("DRIFTMOWER_OPEN_AUTH_URL") == "1" {
		if len(os.Args) != 2 {
			log.Fatal("browser helper requires one URL")
		}
		if err := dashboard.OpenChromeProfile(os.Getenv("DRIFTMOWER_CHROME_BINARY"), os.Getenv("DRIFTMOWER_CHROME_ROOT"), os.Getenv("DRIFTMOWER_CHROME_PROFILE"), os.Args[1], false); err != nil {
			log.Fatal(err)
		}
		return
	}
	cfg := dashboard.LoadConfig(os.Args[1:])
	if cfg.FlagError != nil {
		if errors.Is(cfg.FlagError, flag.ErrHelp) {
			return
		}
		log.Fatal(cfg.FlagError)
	}
	handled, err := controlDesktop(cfg, os.Stdout)
	if err != nil {
		log.Fatal(err)
	}
	if handled {
		return
	}
	cfg.DiscoverKubeconfig, cfg.KubeLogin, cfg.ListenAddr = true, true, listenAddr
	if os.Getenv("ASSET_DIR") == "" {
		assets, err := fs.Sub(frontend, "frontend")
		if err != nil {
			log.Fatal(err)
		}
		cfg.AssetFS = assets
	}
	browser, err := findBrowser()
	if err != nil {
		log.Fatal(err)
	}
	cfg.ChromeProfiles, err = dashboard.NewChromeProfiles(browser, os.Getenv("CHROME_USER_DATA_DIR"))
	if err != nil {
		log.Fatal(err)
	}

	if runtime.GOOS == "linux" || cfg.InstallDesktop {
		binary, err := os.Executable()
		if err != nil {
			log.Fatal(err)
		}
		if err := installDesktop(cfg.ChromeProfiles, binary); err != nil {
			if cfg.InstallDesktop {
				log.Fatal(err)
			}
			log.Printf("Desktop launcher: %v", err)
		} else if cfg.InstallDesktop {
			log.Print("Installed Driftmower launcher, profile taskbar entries and icon")
		}
		if cfg.InstallDesktop {
			return
		}
	}

	listener, err := net.Listen("tcp", listenAddr)
	if errors.Is(err, syscall.EADDRINUSE) {
		instance, readErr := readInstance()
		if readErr == nil && instance.Address == listenAddr && probeInstance(instance) == nil {
			log.Printf("Desktop PID %d is already running on %s", instance.PID, instance.Address)
			if err := cfg.ChromeProfiles.OpenSettings(cfg.ChromeProfile); err != nil {
				log.Fatal(err)
			}
			return
		}
	}

	if err != nil {
		log.Fatal(err)
	}

	db := dashboard.New(cfg)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	instance, err := recordInstance(listenAddr)
	if err != nil {
		log.Fatal(err)
	}
	defer func() { db.Close(); removeInstance(instance) }()
	log.Printf("Desktop PID %d listening at %s", instance.PID, dashboard.DesktopOrigin)
	server := &http.Server{Handler: instanceHandler(db.Handler(), instance, stop), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		if err := server.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	if err := cfg.ChromeProfiles.OpenSettings(cfg.ChromeProfile); err != nil {
		log.Fatal(err)
	}

	started := time.Now()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = server.Shutdown(shutdownCtx)
			cancel()
			return
		case <-ticker.C:
			last := db.LastSeen()
			if last.IsZero() {
				last = started
			}
			if time.Since(last) > idleAfter {
				log.Printf("The dashboard window has been closed; exiting")
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_ = server.Shutdown(ctx)
				cancel()

				return
			}
		}
	}
}

// findBrowser prefers Google Chrome and falls back to Chromium.
func findBrowser() (string, error) {
	var candidates []string
	switch runtime.GOOS {
	case "darwin":
		home, _ := os.UserHomeDir()
		for _, app := range []string{"Google Chrome.app/Contents/MacOS/Google Chrome", "Chromium.app/Contents/MacOS/Chromium"} {
			candidates = append(candidates, filepath.Join("/Applications", app), filepath.Join(home, "Applications", app))
		}
	case "windows":
		for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "LocalAppData"} {
			if dir := os.Getenv(env); dir != "" {
				candidates = append(candidates, filepath.Join(dir, `Google\Chrome\Application\chrome.exe`))
			}
		}
		for _, env := range []string{"ProgramFiles", "LocalAppData"} {
			if dir := os.Getenv(env); dir != "" {
				candidates = append(candidates, filepath.Join(dir, `Chromium\Application\chrome.exe`))
			}
		}
	default:
		for _, name := range []string{"google-chrome-stable", "google-chrome", "chromium", "chromium-browser"} {
			if path, err := exec.LookPath(name); err == nil {
				candidates = append(candidates, path)
			}
		}
	}
	for _, c := range candidates {
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c, nil
		}
	}

	return "", errors.New("google Chrome or Chromium is required")
}
