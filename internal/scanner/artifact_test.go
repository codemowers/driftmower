package scanner

import (
	"bytes"
	"compress/gzip"
	"io"
	"testing"
)

func gzipTestBytes(t *testing.T, body []byte) []byte {
	t.Helper()
	var out bytes.Buffer
	writer := gzip.NewWriter(&out)
	if _, err := writer.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestValidateCompressedSBOM(t *testing.T) {
	body := []byte(`{"bomFormat":"CycloneDX","components":[]}`)
	compressed := gzipTestBytes(t, body)
	size, err := validateCompressedSBOM(bytes.NewReader(compressed))
	if err != nil || size != int64(len(body)) {
		t.Fatalf("size=%d error=%v", size, err)
	}
	for _, bad := range [][]byte{body, compressed[:len(compressed)-3], gzipTestBytes(t, []byte(`{"bomFormat":"other"}`)), gzipTestBytes(t, append(bytes.Clone(body), []byte(` {}`)...))} {
		if _, err := validateCompressedSBOM(bytes.NewReader(bad)); err == nil {
			t.Fatal("accepted invalid artifact")
		}
	}
	corrupt := bytes.Clone(compressed)
	corrupt[len(corrupt)-8] ^= 1
	if _, err := validateCompressedSBOM(bytes.NewReader(corrupt)); err == nil {
		t.Fatal("accepted invalid gzip checksum")
	}
	bomb := gzipTestBytes(t, bytes.Repeat([]byte(" "), MaxSBOMBytes+128))
	size, err = validateCompressedSBOM(bytes.NewReader(bomb))
	if err == nil || size != MaxSBOMBytes+1 {
		t.Fatalf("decompression limit: %d %v", size, err)
	}
}

func TestGzipNegotiation(t *testing.T) {
	for _, tc := range []struct {
		header string
		want   bool
	}{{"", true}, {"gzip, deflate, br, zstd", true}, {"identity", false}, {"gzip;q=0, *;q=1", false}, {"*;q=0, gzip;q=0.5", true}, {"gzip;q=bad", false}, {"*", true}} {
		if got := acceptsGzip(tc.header); got != tc.want {
			t.Errorf("%q: %v", tc.header, got)
		}
	}
}

// Compile-time reader check keeps validation and summary counting streaming.
var _ io.Reader = (*countingReader)(nil)
