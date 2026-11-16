package registry

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// Reader uses its own projected service token, never the browser's MCP bearer.
type Reader struct {
	URL, TokenFile string
	HTTP           *http.Client
}

func (c *Reader) JSON(ctx context.Context, method, path string, input, out any) error {
	if c == nil || c.URL == "" {
		return errors.New("registry scraper is not configured")
	}
	var token []byte
	var err error
	if c.TokenFile != "" {
		token, err = os.ReadFile(c.TokenFile)
	}
	if err != nil {
		return fmt.Errorf("registry scraper token: %w", err)
	}
	var body []byte
	if input != nil {
		body, err = json.Marshal(input)
		if err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.URL, "/")+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	if len(token) > 0 {
		req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("registry scraper HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20+1))
	if err != nil {
		return err
	}
	if len(data) > 16<<20 {
		return errors.New("registry scraper response exceeds 16 MiB")
	}
	return json.Unmarshal(data, out)
}
