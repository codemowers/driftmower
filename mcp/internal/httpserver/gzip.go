package httpserver

import (
	"compress/gzip"
	"net/http"
	"strings"
	"sync"
)

var gzipWriters = sync.Pool{New: func() any { w, _ := gzip.NewWriterLevel(nil, gzip.DefaultCompression); return w }}

// compressible covers MCP JSON and event-stream answers and text pages.
func compressible(contentType string) bool {
	return strings.HasPrefix(contentType, "application/json") || strings.HasPrefix(contentType, "text/")
}

// Gzip compresses responses for clients that accept it. Responses that set
// their own Content-Encoding, such as stored SBOM artifacts, pass through.
// Flush compresses what is buffered so far, keeping event streams live.
func Gzip(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead || !acceptsGzip(r.Header.Get("Accept-Encoding")) {
			next.ServeHTTP(w, r)
			return
		}
		g := &gzipResponse{ResponseWriter: w}
		defer g.close()
		w.Header().Add("Vary", "Accept-Encoding")
		next.ServeHTTP(g, r)
	})
}

func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(name), "gzip") {
			return !strings.Contains(strings.ReplaceAll(params, " ", ""), "q=0")
		}
	}
	return false
}

type gzipResponse struct {
	http.ResponseWriter
	gz      *gzip.Writer
	decided bool
}

func (g *gzipResponse) decide(status int) {
	if g.decided {
		return
	}
	g.decided = true
	h := g.Header()
	if h.Get("Content-Encoding") != "" || status < 200 || status == http.StatusNoContent || status == http.StatusNotModified || !compressible(h.Get("Content-Type")) {
		return
	}
	h.Set("Content-Encoding", "gzip")
	h.Del("Content-Length")
	g.gz = gzipWriters.Get().(*gzip.Writer)
	g.gz.Reset(g.ResponseWriter)
}

func (g *gzipResponse) WriteHeader(status int) {
	g.decide(status)
	g.ResponseWriter.WriteHeader(status)
}

func (g *gzipResponse) Write(p []byte) (int, error) {
	if !g.decided {
		if g.Header().Get("Content-Type") == "" {
			g.Header().Set("Content-Type", http.DetectContentType(p))
		}
		g.WriteHeader(http.StatusOK)
	}
	if g.gz != nil {
		return g.gz.Write(p)
	}
	return g.ResponseWriter.Write(p)
}

func (g *gzipResponse) Flush() {
	if g.gz != nil {
		_ = g.gz.Flush()
	}
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (g *gzipResponse) Unwrap() http.ResponseWriter { return g.ResponseWriter }

func (g *gzipResponse) close() {
	if g.gz != nil {
		_ = g.gz.Close()
		gzipWriters.Put(g.gz)
		g.gz = nil
	}
}
