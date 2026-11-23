package imageanalysis

import (
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFullWalkRetainsOnlyNewestFilesAndProbesKnownShells(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 1100; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("entry-%04d", i)), []byte("text"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(filepath.Join(root, fmt.Sprintf("entry-%04d", i)), time.Unix(int64(i), 0), time.Unix(int64(i), 0)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "usr/local/bin"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "usr/local/bin/bash"), []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
	stamp := time.Date(2026, 11, 19, 1, 2, 3, 0, time.UTC)
	if err := os.Chtimes(filepath.Join(root, "usr/local/bin/bash"), stamp, stamp); err != nil {
		t.Fatal(err)
	}
	got, err := Inspect(context.Background(), root)
	if err != nil || got.Entries != 1104 || got.Truncated || len(got.NewestFiles) != NewestFileLimit || !got.NewestFilesTruncated {
		t.Fatalf("full enumeration or retained-file bound incorrect: %+v %v", got, err)
	}
	if got.LatestFileModifiedAt == nil || !got.LatestFileModifiedAt.Equal(stamp) || got.NewestFiles[0].Path != "/usr/local/bin/bash" {
		t.Fatalf("latest file timestamp incorrect: %+v", got.LatestFileModifiedAt)
	}
	if len(got.Shells) != 1 || got.Shells[0].Path != "/usr/local/bin/bash" {
		t.Fatalf("shell probes affected by enumeration cap: %+v", got.Shells)
	}
	total := 0
	for _, count := range got.MIME {
		total += count
	}
	if total != got.Files {
		t.Fatalf("MIME counts %d files %d", total, got.Files)
	}
}
func TestAbsoluteSymlinksResolveWithinImage(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "usr/bin"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "usr/bin/dash"), []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/usr/bin", filepath.Join(root, "bin")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/usr/bin/dash", filepath.Join(root, "usr/bin/sh")); err != nil {
		t.Fatal(err)
	}
	resolved, err := Resolve(root, "/bin/sh")
	if err != nil || resolved != filepath.Join(root, "usr/bin/dash") {
		t.Fatalf("image symlink did not rebase: %s %v", resolved, err)
	}
	if err := os.Symlink("/missing", filepath.Join(root, "usr/bin/bash")); err != nil {
		t.Fatal(err)
	}
	got, err := Inspect(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	for _, shell := range got.Shells {
		if shell.Path == "/bin/bash" || shell.Path == "/usr/bin/bash" {
			t.Fatal("broken image link resolved against inspector host")
		}
	}
}
func TestStaticELFEvidence(t *testing.T) {
	// A minimal, valid ELF64 executable with no interpreter or dynamic section.
	body := make([]byte, 64)
	copy(body, "\x7fELF")
	body[4] = 2
	body[5] = 1
	body[6] = 1
	binary.LittleEndian.PutUint16(body[16:], 2)
	binary.LittleEndian.PutUint16(body[18:], 62)
	binary.LittleEndian.PutUint32(body[20:], 1)
	binary.LittleEndian.PutUint64(body[24:], 0x400000)
	binary.LittleEndian.PutUint16(body[52:], 64)
	path := filepath.Join(t.TempDir(), "app")
	if err := os.WriteFile(path, body, 0755); err != nil {
		t.Fatal(err)
	}
	got, err := InspectELF(path)
	if err != nil || got == nil || got.Linking != "static" {
		t.Fatalf("static ELF evidence: %+v %v", got, err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\necho hi"), 0755); err != nil {
		t.Fatal(err)
	}
	if got, err := InspectELF(path); got != nil || err != nil {
		t.Fatalf("script classified as static ELF: %+v %v", got, err)
	}
}
