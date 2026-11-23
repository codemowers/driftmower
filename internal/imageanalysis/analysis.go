// Package imageanalysis inspects mounted image files without executing them.
package imageanalysis

import (
	"container/heap"
	"context"
	"debug/elf"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

const NewestFileLimit = 1000
const SchemaVersion = 1

type Binary struct {
	NeededTruncated bool     `json:"neededTruncated,omitempty"`
	Path            string   `json:"path"`
	Linking         string   `json:"linking"`
	Architecture    string   `json:"architecture,omitempty"`
	Interpreter     string   `json:"interpreter,omitempty"`
	Needed          []string `json:"needed,omitempty"`
	Error           string   `json:"error,omitempty"`
}
type Shell struct {
	Path         string `json:"path"`
	ResolvedPath string `json:"resolvedPath"`
}
type File struct {
	Path       string    `json:"path"`
	ModifiedAt time.Time `json:"modifiedAt"`
	Size       int64     `json:"size"`
	MIME       string    `json:"mimeType"`
}
type newestFiles []*File

func (f newestFiles) Len() int { return len(f) }
func (f newestFiles) Less(i, j int) bool {
	if f[i].ModifiedAt.Equal(f[j].ModifiedAt) {
		return f[i].Path < f[j].Path
	}
	return f[i].ModifiedAt.Before(f[j].ModifiedAt)
}
func (f newestFiles) Swap(i, j int)   { f[i], f[j] = f[j], f[i] }
func (f *newestFiles) Push(value any) { *f = append(*f, value.(*File)) }
func (f *newestFiles) Pop() any {
	old := *f
	value := old[len(old)-1]
	*f = old[:len(old)-1]
	return value
}

type Report struct {
	NewestFiles          []File              `json:"newestFiles"`
	NewestFileLimit      int                 `json:"newestFileLimit"`
	NewestFilesTruncated bool                `json:"newestFilesTruncated"`
	LatestFileModifiedAt *time.Time          `json:"latestFileModifiedAt,omitempty"`
	LatestFilePath       string              `json:"latestFilePath,omitempty"`
	LinkingCounts        map[string]int      `json:"linkingCounts"`
	BinariesTruncated    bool                `json:"binariesTruncated,omitempty"`
	Tools                map[string][]string `json:"tools"`
	SchemaVersion        int                 `json:"schemaVersion"`
	ObservedAt           string              `json:"observedAt"`
	Entries              int                 `json:"entriesExamined"`
	Files                int                 `json:"filesObserved"`
	Directories          int                 `json:"directoriesObserved"`
	Symlinks             int                 `json:"symlinksObserved"`
	Truncated            bool                `json:"truncated"`
	MIME                 map[string]int      `json:"mimeTypes"`
	Shells               []Shell             `json:"shells"`
	Binaries             []Binary            `json:"binaries"`
	Errors               []string            `json:"errors,omitempty"`
}

// Resolve gives absolute symlinks the image's root, never the inspector's root.
// Symlink traversal and '..' are bounded and confined to the mounted image.
func Resolve(root, path string) (string, error) {
	pending := strings.Split(strings.TrimPrefix(path, "/"), "/")
	var done []string
	links := 0
	for len(pending) > 0 {
		part := pending[0]
		pending = pending[1:]
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			if len(done) > 0 {
				done = done[:len(done)-1]
			}
			continue
		}
		current := filepath.Join(append([]string{root}, append(done, part)...)...)
		info, err := os.Lstat(current)
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			links++
			if links > 40 {
				return "", errors.New("too many image symlinks")
			}
			target, err := os.Readlink(current)
			if err != nil {
				return "", err
			}
			if filepath.IsAbs(target) {
				done = nil
			}
			pending = append(strings.Split(target, "/"), pending...)
			continue
		}
		done = append(done, part)
	}
	return filepath.Join(append([]string{root}, done...)...), nil
}

type boundedReaderAt struct {
	r         io.ReaderAt
	remaining int64
}

func (r *boundedReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if int64(len(p)) > r.remaining {
		return 0, errors.New("ELF inspection exceeds 1 MiB read budget")
	}
	r.remaining -= int64(len(p))
	return r.r.ReadAt(p, off)
}

// InspectELF distinguishes executables from shared libraries and never infers
// static linking solely from a base image, language or absent interpreter.
func InspectELF(path string) (*Binary, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var magic [4]byte
	if _, err = file.ReadAt(magic[:], 0); err != nil && err != io.EOF {
		return nil, err
	}
	if string(magic[:]) != "\x7fELF" {
		return nil, nil
	}
	out := &Binary{Linking: "unknown"}
	e, err := elf.NewFile(&boundedReaderAt{file, 1 << 20})
	if err != nil {
		out.Error = err.Error()
		return out, nil
	}
	defer e.Close()
	out.Architecture = e.Machine.String()
	if e.Type != elf.ET_EXEC && (e.Type != elf.ET_DYN || e.Entry == 0) {
		out.Linking = "shared object"
		return out, nil
	}
	for _, p := range e.Progs {
		if p.Type == elf.PT_INTERP {
			if p.Filesz > 4096 {
				out.Error = "interpreter exceeds size limit"
				return out, nil
			}
			body, err := io.ReadAll(io.LimitReader(p.Open(), 4097))
			if err != nil {
				out.Error = err.Error()
				return out, nil
			}
			out.Interpreter = strings.TrimRight(string(body), "\x00")
		}
	}
	out.Needed, err = e.DynString(elf.DT_NEEDED)
	if err != nil {
		out.Error = err.Error()
		return out, nil
	}
	out.Linking = "static"
	if out.Interpreter != "" || len(out.Needed) > 0 {
		out.Linking = "dynamic"
	}
	if len(out.Needed) > 16 {
		out.NeededTruncated = true
		out.Needed = out.Needed[:16]
	}
	for i, value := range out.Needed {
		if len(value) > 128 {
			out.NeededTruncated = true
			out.Needed[i] = value[:128]
		}
	}
	return out, nil
}

func Inspect(ctx context.Context, root string) (Report, error) {
	out := Report{LinkingCounts: map[string]int{}, SchemaVersion: SchemaVersion, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), NewestFileLimit: NewestFileLimit, NewestFiles: []File{}, MIME: map[string]int{}, Tools: map[string][]string{}, Shells: []Shell{}, Binaries: []Binary{}}
	recordError := func(path string, err error) {
		out.Truncated = true
		if len(out.Errors) < 20 {
			message := path + ": " + err.Error()
			if len(message) > 512 {
				message = message[:512]
			}
			out.Errors = append(out.Errors, message)
		}
	}
	// Known-location probes are independent of the bounded directory walk.
	for _, dir := range []string{"/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin"} {
		for _, name := range []string{"sh", "bash", "ash", "dash", "zsh", "ksh", "busybox"} {
			path := dir + "/" + name
			resolved, err := Resolve(root, path)
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				recordError(path, err)
				continue
			}
			info, err := os.Stat(resolved)
			if err != nil {
				recordError(path, err)
				continue
			}
			if info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 {
				if name == "busybox" {
					out.Tools["busybox"] = append(out.Tools["busybox"], path)
					continue
				}
				out.Shells = append(out.Shells, Shell{path, "/" + strings.TrimPrefix(strings.TrimPrefix(resolved, root), "/")})
			}
		}
	}
	newest := &newestFiles{}
	heap.Init(newest)
	var walk func(string, int) error
	walk = func(path string, depth int) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		dir, err := os.Open(path)
		if err != nil {
			recordError("/"+strings.TrimPrefix(strings.TrimPrefix(path, root), "/"), err)
			return nil
		}
		defer dir.Close()
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			// Stream names instead of allocating every directory entry at once.
			entries, err := dir.ReadDir(1)
			if err == io.EOF {
				return nil
			}
			if err != nil {
				return err
			}
			entry := entries[0]
			out.Entries++
			rel := filepath.Join(path, entry.Name())
			imagePath := "/" + strings.TrimPrefix(strings.TrimPrefix(rel, root), "/")
			info, err := entry.Info()
			if err != nil {
				recordError(imagePath, err)
				continue
			}
			switch {
			case entry.Type()&fs.ModeSymlink != 0:
				out.Symlinks++
			case entry.IsDir():
				out.Directories++
				if err := walk(rel, depth+1); err != nil {
					return err
				}
			case info.Mode().IsRegular():
				out.Files++
				modified := info.ModTime().UTC()
				if out.LatestFileModifiedAt == nil || modified.After(*out.LatestFileModifiedAt) {
					out.LatestFileModifiedAt = &modified
					out.LatestFilePath = imagePath
				}
				record := File{Path: imagePath, ModifiedAt: modified, Size: info.Size(), MIME: "unknown"}

				if newest.Len() < NewestFileLimit {
					heap.Push(newest, &record)
				} else if modified.After((*newest)[0].ModifiedAt) || modified.Equal((*newest)[0].ModifiedAt) && record.Path > (*newest)[0].Path {
					heap.Pop(newest)
					heap.Push(newest, &record)
				}
				file, err := os.Open(rel)
				if err != nil {
					recordError(imagePath, err)
					out.MIME["unknown"]++
					continue
				}
				var head [512]byte
				n, readErr := file.Read(head[:])
				file.Close()
				if readErr != nil && readErr != io.EOF {
					recordError(imagePath, readErr)
					out.MIME["unknown"]++
					continue
				}
				kind := strings.Split(http.DetectContentType(head[:n]), ";")[0]
				if n >= 4 && string(head[:4]) == "\x7fELF" {
					kind = "application/x-elf"
					binary, err := InspectELF(rel)
					if err != nil {
						recordError(imagePath, err)
					} else if binary != nil {
						binary.Path = imagePath
						out.LinkingCounts[binary.Linking]++
						if len(out.Binaries) < 128 {
							out.Binaries = append(out.Binaries, *binary)
						} else {
							out.BinariesTruncated = true
						}
					}
				}
				out.MIME[kind]++
				record.MIME = kind
			}
		}
	}
	if err := walk(root, 0); err != nil {
		out.Truncated = true
		recordError("/", err)
	}
	for _, file := range *newest {
		out.NewestFiles = append(out.NewestFiles, *file)
	}
	out.NewestFilesTruncated = out.Files > NewestFileLimit
	slices.SortFunc(out.NewestFiles, func(a, b File) int {
		if a.ModifiedAt.Equal(b.ModifiedAt) {
			return strings.Compare(b.Path, a.Path)
		}
		return b.ModifiedAt.Compare(a.ModifiedAt)
	})
	slices.SortFunc(out.Shells, func(a, b Shell) int { return strings.Compare(a.Path, b.Path) })
	slices.SortFunc(out.Binaries, func(a, b Binary) int { return strings.Compare(a.Path, b.Path) })
	return out, nil
}
