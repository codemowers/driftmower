package dashboard

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func TestStaticAssetsFromFilesystemAndEmbeddedFS(t *testing.T) {
	fixture := fstest.MapFS{
		"index.html":   &fstest.MapFile{Data: []byte("<!doctype html><html>dashboard</html>")},
		"_next/app.js": &fstest.MapFile{Data: []byte("console.log('dashboard')")},
	}
	dir := t.TempDir()
	for name, file := range fixture {
		full := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, file.Data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name      string
		assets    fs.FS
		directory string
	}{
		{name: "embedded", assets: fixture}, {name: "directory", directory: dir},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := New(&Config{AssetFS: tc.assets, AssetDir: tc.directory})
			defer app.Close()
			for _, request := range []struct {
				path    string
				status  int
				content string
			}{
				{"/", 200, "text/html"}, {"/namespaces/team", 200, "text/html"},
				{"/_next/app.js", 200, "javascript"}, {"/_next/missing.js", 404, ""}, {"/api/unknown", 404, ""},
			} {
				recorder := httptest.NewRecorder()
				app.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, request.path, nil))
				if recorder.Code != request.status {
					t.Fatalf("%s: status %d", request.path, recorder.Code)
				}
				if !strings.Contains(recorder.Header().Get("Content-Type"), request.content) {
					t.Fatalf("%s: type %q", request.path, recorder.Header().Get("Content-Type"))
				}
				if recorder.Header().Get("X-Content-Type-Options") != "nosniff" {
					t.Fatal("missing security header")
				}
			}
		})
	}
}
