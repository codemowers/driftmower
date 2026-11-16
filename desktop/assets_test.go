package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codemowers/driftmower/desktop/dashboard"
)

func TestEmbeddedFrontendWithoutExternalFiles(t *testing.T) {
	assets, err := fs.Sub(frontend, "frontend")
	if err != nil {
		t.Fatal(err)
	}
	index, err := fs.ReadFile(assets, "index.html")
	if err != nil {
		t.Fatal("run desktop/build.sh before testing:", err)
	}
	var javascript, stylesheet string
	err = fs.WalkDir(assets, "_next", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if strings.HasSuffix(name, ".js") && javascript == "" {
			javascript = name
		}
		if strings.HasSuffix(name, ".css") && stylesheet == "" {
			stylesheet = name
		}
		return nil
	})
	if err != nil || javascript == "" || stylesheet == "" {
		t.Fatal("missing embedded JS/CSS", err)
	}
	app := dashboard.New(&dashboard.Config{AssetFS: assets, AssetDir: "/does-not-exist"})
	defer app.Close()
	handler := app.Handler()
	for _, name := range []string{"/", "/executive-summary", "/callback", "/" + javascript, "/" + stylesheet} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, name, nil))
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status %d", name, recorder.Code)
		}
		if name == "/" || name == "/executive-summary" || name == "/callback" {
			if recorder.Body.String() != string(index) {
				t.Fatalf("%s: incorrect SPA fallback", name)
			}
		}
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/_next/missing.js", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("missing JS returned %d", recorder.Code)
	}
}
