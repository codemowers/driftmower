package scanner

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
)

const artifactSuffix = ".json.gz"

// Gzip framing can make incompressible data slightly larger than its input.
const MaxCompressedSBOMBytes = MaxSBOMBytes + (1 << 20)

type countingReader struct {
	io.Reader
	bytes int64
}

func (r *countingReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	r.bytes += int64(n)
	return n, err
}

// Validation consumes the gzip trailer as well as the JSON, so truncated or
// corrupt streams cannot be persisted. The limit applies after decompression.
func validateCompressedSBOM(source io.Reader) (int64, error) {
	reader, err := gzip.NewReader(source)
	if err != nil {
		return 0, err
	}
	defer func() { _ = reader.Close() }()
	bounded := &countingReader{Reader: io.LimitReader(reader, MaxSBOMBytes+1)}
	decoder := json.NewDecoder(bounded)
	var bom struct {
		Format string `json:"bomFormat"`
	}
	err = decoder.Decode(&bom)
	if err == nil && bom.Format != "CycloneDX" {
		err = fmt.Errorf("invalid SBOM format")
	}
	if err == nil {
		if trailing := decoder.Decode(new(any)); trailing != io.EOF {
			if trailing == nil {
				err = fmt.Errorf("trailing SBOM data")
			} else {
				err = trailing
			}
		}
	}
	if bounded.bytes > MaxSBOMBytes {
		return bounded.bytes, fmt.Errorf("SBOM exceeds uncompressed size limit")
	}
	return bounded.bytes, err
}

// An absent Accept-Encoding permits any encoding. Explicit identity-only or
// gzip;q=0 requests cannot be served from this gzip-only artifact endpoint.
func acceptsGzip(header string) bool {
	if strings.TrimSpace(header) == "" {
		return true
	}
	wildcard := false
	for _, entry := range strings.Split(header, ",") {
		parts := strings.Split(entry, ";")
		name := strings.ToLower(strings.TrimSpace(parts[0]))
		quality := 1.0
		for _, parameter := range parts[1:] {
			key, value, ok := strings.Cut(strings.TrimSpace(parameter), "=")
			if ok && strings.EqualFold(key, "q") {
				parsed, err := strconv.ParseFloat(value, 64)
				if err != nil || parsed < 0 || parsed > 1 {
					quality = 0
				} else {
					quality = parsed
				}
			}
		}
		if name == "gzip" {
			return quality > 0
		}
		if name == "*" {
			wildcard = quality > 0
		}
	}
	return wildcard
}
