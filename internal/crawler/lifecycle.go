package crawler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/codemowers/driftmower/internal/lifecycle"
)

const lifecycleURL = "https://endoflife.date/api/v1/products/full/"
const lifecycleTTL = 14 * 24 * time.Hour

type lifecycleCache struct {
	mu        sync.RWMutex
	products  []lifecycle.Product
	checkedAt time.Time
	nextCheck time.Time
	lastError string
	fetch     *fetcher
	rulesFile string
	ttl       time.Duration
}

func (c *Crawler) OpenLifecycle(rulesFile string, ttl time.Duration) error {
	if c.cfg.CacheDir == "" {
		return errors.New("lifecycle metadata requires crawler cache directory")
	}
	if ttl <= 0 {
		ttl = lifecycleTTL
	}
	f := newFetcher(PublicHTTPClient(), "")
	f.cacheDir = c.cfg.CacheDir
	f.bodyLimit = 64 << 20
	f.validate = func(body []byte) error { _, err := parseLifecycle(body); return err }
	f.metrics = c.fetch.metrics
	l := &lifecycleCache{fetch: f, rulesFile: rulesFile, ttl: ttl}
	c.lifecycle = l
	cached, found, err := f.diskResponse(lifecycleURL, f.limit())
	if err != nil {
		l.lastError = "restore lifecycle cache: " + err.Error()
		found = false
	}
	if found {
		if err = l.decode(cached.body); err != nil {
			l.lastError = "restore lifecycle cache: " + err.Error()
		} else {
			l.checkedAt = cached.checkedAt
			l.nextCheck = l.checkedAt.Add(ttl)
		}
	}
	_, err = l.rules()
	return err
}
func (l *lifecycleCache) rules() (map[string]lifecycle.Rule, error) {
	var body []byte
	var err error
	if l.rulesFile != "" {
		body, err = os.ReadFile(l.rulesFile)
		if err != nil {
			return nil, err
		}
	}
	return lifecycle.Rules(body)
}
func parseLifecycle(body []byte) ([]lifecycle.Product, error) {
	var envelope struct {
		Result []lifecycle.Product `json:"result"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, err
	}
	if len(envelope.Result) == 0 {
		return nil, errors.New("empty lifecycle catalog")
	}
	return envelope.Result, nil
}
func (l *lifecycleCache) decode(body []byte) error {
	products, err := parseLifecycle(body)
	if err != nil {
		return err
	}
	l.products = products
	return nil
}

func (c *Crawler) RunLifecycle(ctx context.Context) {
	if c.lifecycle == nil {
		return
	}
	l := c.lifecycle
	timer := time.NewTicker(time.Hour)
	defer timer.Stop()
	for {
		l.mu.RLock()
		due := !time.Now().Before(l.nextCheck)
		l.mu.RUnlock()
		if due {
			body, err := l.fetch.get(ctx, lifecycleURL, false)
			l.mu.Lock()
			if err == nil {
				err = l.decode(body)
			}
			if err != nil {
				l.lastError = err.Error()
				l.nextCheck = time.Now().Add(time.Hour)
			} else {
				l.checkedAt = time.Now().UTC()
				l.nextCheck = l.checkedAt.Add(l.ttl)
				l.lastError = ""
			}
			l.mu.Unlock()
			if err != nil {
				c.log.Warn("lifecycle refresh failed", "error", err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
	}
}
func (c *Crawler) Lifecycles(queries []lifecycle.Query) lifecycle.Result {
	out := lifecycle.Result{Matches: map[string]lifecycle.Match{}, Stale: true}
	if c.lifecycle == nil {
		out.Errors = []string{"lifecycle metadata is disabled"}
		return out
	}
	l := c.lifecycle
	rules, err := l.rules()
	if err != nil {
		out.Errors = []string{fmt.Sprintf("lifecycle mapping configuration: %v", err)}
		return out
	}
	l.mu.RLock()
	defer l.mu.RUnlock()
	out.CheckedAt = l.checkedAt
	out.NextCheck = l.nextCheck
	out.Stale = l.checkedAt.IsZero() || time.Since(l.checkedAt) > l.ttl
	if l.lastError != "" {
		out.Errors = []string{l.lastError}
	}
	if len(l.products) == 0 {
		out.Errors = append(out.Errors, "lifecycle metadata not yet fetched")
	}
	out.Matches = lifecycle.Resolve(l.products, rules, queries)
	return out
}
