package registry

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/codemowers/driftmower/internal/httpcache"
	"io"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"
)

type API struct {
	Store        *Store
	Authenticate func(context.Context, string) (string, error)
	Allowed      []string
	Status       *RegistryStatusTracker
}

func (a *API) Handler() http.Handler {
	writeJSON := func(w http.ResponseWriter, r *http.Request, value any) {

		httpcache.JSON(w, r, value)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/repositories", func(w http.ResponseWriter, r *http.Request) {
		out := map[string]any{"repositories": a.Store.Summaries(), "observedAt": a.Store.UpdatedAt()}
		if a.Status != nil {
			out["registries"] = a.Status.Snapshot(time.Now())
		}
		writeJSON(w, r, out)
	})
	mux.HandleFunc("GET /v1/repository", func(w http.ResponseWriter, r *http.Request) {
		digest := r.URL.Query().Get("digest")
		if digest != "" && !digestPattern.MatchString(digest) {
			http.Error(w, "invalid manifest digest", 400)
			return
		}
		page, ok := a.Store.Repository(r.URL.Query().Get("name"), digest)
		if !ok {
			http.NotFound(w, r)
			return
		}
		writeJSON(w, r, page)
	})
	mux.HandleFunc("POST /v1/hierarchy", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Images []Target `json:"images"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || len(input.Images) == 0 || len(input.Images) > 16 {
			http.Error(w, "expected 1 to 16 platform images", 400)
			return
		}
		out := HierarchyResult{Hierarchies: []Hierarchy{}}
		for _, target := range input.Images {
			if !digestPattern.MatchString(target.Digest) || target.Platform.Architecture == "" || len(target.Layers) > 256 {
				http.Error(w, "invalid target image", 400)
				return
			}
			if target.Platform.OS == "" {
				target.Platform.OS = "linux"
			}
			for _, layer := range target.Layers {
				if !digestPattern.MatchString(layer.Digest) || (layer.DiffID != "" && !digestPattern.MatchString(layer.DiffID)) {
					http.Error(w, "invalid layer digest", 400)
					return
				}
			}
			out.Hierarchies = append(out.Hierarchies, a.Store.Hierarchy(target))
		}
		out.Warnings = []string{"Stages are complete catalog image chains matching ordered filesystem prefixes. They establish shared layers, not a unique Dockerfile parent. Scratch denotes the empty filesystem root; unindexed intermediate images are unknown."}
		writeJSON(w, r, out)
	})
	mux.HandleFunc("GET /v1/configs/{digest}", func(w http.ResponseWriter, r *http.Request) {
		path, err := a.Store.objectPath("config", r.PathValue("digest"))
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if r.URL.Query().Get("encoding") == "base64" {
			body, err := os.ReadFile(path)
			if errors.Is(err, os.ErrNotExist) {
				http.NotFound(w, r)
				return
			}
			if err != nil {
				http.Error(w, "config unavailable", 503)
				return
			}
			writeJSON(w, r, map[string]any{"digest": r.PathValue("digest"), "gzipBase64": base64.StdEncoding.EncodeToString(body)})
			return
		}
		file, err := os.Open(path)
		if errors.Is(err, os.ErrNotExist) {
			http.NotFound(w, r)
			return
		}
		if err != nil {
			http.Error(w, "config unavailable", 503)
			return
		}
		defer file.Close()
		info, err := file.Stat()
		if err != nil {
			http.Error(w, "config unavailable", 503)
			return
		}
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
		w.Header().Set("ETag", `"`+r.PathValue("digest")+`"`)
		if r.URL.Query().Get("download") == "true" {
			w.Header().Set("Content-Type", "application/gzip")
		} else {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Content-Encoding", "gzip")
		}
		w.Header().Set("Content-Disposition", `attachment; filename="config.json.gz"`)
		http.ServeContent(w, r, "config.json.gz", info.ModTime(), file)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")

		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok {
			http.Error(w, "bearer token required", 401)
			return
		}
		user, err := a.Authenticate(r.Context(), token)
		if err != nil {
			http.Error(w, "unauthorized", 401)
			return
		}
		if !slices.Contains(a.Allowed, user) {
			http.Error(w, "forbidden", 403)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
