package mcpserver

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func dashboardURI(session *mcp.ServerSession) string {
	sum := sha256.Sum256([]byte(session.ID()))
	return "driftmower://dashboard/" + hex.EncodeToString(sum[:])
}

// Each session gets a private subscription URI. Only its authorized view is
// fingerprinted, excluding the cluster-wide revision, so another namespace's
// activity cannot leak through notification timing. Payloads contain no data.
func dashboardSubscriptions(opts *mcp.ServerOptions, d Deps, server **mcp.Server) {
	if d.Workloads == nil {
		return
	}
	var mu sync.Mutex
	type subscription struct{ cancel context.CancelFunc }
	active := map[*mcp.ServerSession]*subscription{}
	opts.SubscribeHandler = func(ctx context.Context, req *mcp.SubscribeRequest) error {
		if req.Params.URI != dashboardURI(req.Session) {
			return errors.New("unknown subscription")
		}
		if req.Extra == nil || req.Extra.TokenInfo == nil || req.Extra.TokenInfo.Expiration.IsZero() {
			return errors.New("subscription requires an expiring bearer token")
		}
		id, err := callerIdentity(&mcp.CallToolRequest{Extra: req.Extra}, d.Mapping)
		if err != nil {
			return err
		}
		initial, err := d.Workloads.Cache.List(ctx, "", id)
		if err != nil {
			return err
		}
		mu.Lock()
		defer mu.Unlock()
		if old := active[req.Session]; old != nil {
			old.cancel()
		}
		lifetime, cancel := context.WithDeadline(context.Background(), req.Extra.TokenInfo.Expiration)
		current := &subscription{cancel: cancel}
		active[req.Session] = current
		go func() { _ = req.Session.Wait(); cancel() }()
		go func() {
			defer func() {
				cancel()
				mu.Lock()
				if active[req.Session] == current {
					delete(active, req.Session)
				}
				mu.Unlock()
			}()
			ticker := time.NewTicker(15 * time.Second)
			defer ticker.Stop()
			// The authorized view is rebuilt only once the cache changed, and
			// every five minutes for permission changes the cache does not see.
			seen, unchanged := initial.Revision, 0
			initial.Revision = ""
			encoded, _ := json.Marshal(initial)
			previous := sha256.Sum256(encoded)
			for {
				select {
				case <-lifetime.Done():
					return
				case <-ticker.C:
				}
				version := d.Workloads.Cache.Version()
				if version == seen && unchanged < 20 {
					unchanged++

					continue
				}
				seen, unchanged = version, 0
				readCtx, done := context.WithTimeout(lifetime, 10*time.Second)
				inv, err := d.Workloads.Cache.List(readCtx, "", id)
				done()
				if err != nil {
					continue
				}
				inv.Revision = ""
				encoded, err := json.Marshal(inv)
				if err != nil {
					continue
				}
				digest := sha256.Sum256(encoded)
				if digest != previous {
					previous = digest
					_ = (*server).ResourceUpdated(lifetime, &mcp.ResourceUpdatedNotificationParams{URI: req.Params.URI})
				}
			}
		}()
		return nil
	}
	opts.UnsubscribeHandler = func(_ context.Context, req *mcp.UnsubscribeRequest) error {
		if req.Params.URI != dashboardURI(req.Session) {
			return errors.New("unknown subscription")
		}
		mu.Lock()
		defer mu.Unlock()
		if current := active[req.Session]; current != nil {
			current.cancel()
			delete(active, req.Session)
		}
		return nil
	}
}
