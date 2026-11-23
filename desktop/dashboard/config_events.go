package dashboard

import (
	"fmt"
	"net"
	"net/http"
	"sync"
	"time"
)

type configUpdates struct {
	mu          sync.Mutex
	subscribers map[chan struct{}]struct{}
	err         string
}

func (d *ContextDiscovery) notify() {
	d.updates.mu.Lock()
	defer d.updates.mu.Unlock()
	for channel := range d.updates.subscribers {
		select {
		case channel <- struct{}{}:
		default:
		}
	}
}
func (d *ContextDiscovery) subscribe() (<-chan struct{}, func()) {
	channel := make(chan struct{}, 1)
	d.updates.mu.Lock()
	if d.updates.subscribers == nil {
		d.updates.subscribers = map[chan struct{}]struct{}{}
	}
	d.updates.subscribers[channel] = struct{}{}
	d.updates.mu.Unlock()
	return channel, func() { d.updates.mu.Lock(); delete(d.updates.subscribers, channel); d.updates.mu.Unlock() }
}
func (d *ContextDiscovery) watchError() string {
	d.updates.mu.Lock()
	defer d.updates.mu.Unlock()
	return d.updates.err
}
func (d *ContextDiscovery) setWatchError(err error) {
	d.updates.mu.Lock()
	if err != nil {
		d.updates.err = "Kubeconfig watcher: " + err.Error()
	} else {
		d.updates.err = ""
	}
	d.updates.mu.Unlock()
	d.notify()
}
func (d *ContextDiscovery) hasConfigClients() bool {
	d.updates.mu.Lock()
	defer d.updates.mu.Unlock()
	return len(d.updates.subscribers) > 0
}

func (d *Dashboard) configEvents(w http.ResponseWriter, r *http.Request) {
	host, _, err := net.SplitHostPort(r.Host)
	ip := net.ParseIP(host)
	if err != nil || host != "localhost" && (ip == nil || !ip.IsLoopback()) || r.Header.Get("Origin") != "" && r.Header.Get("Origin") != "http://"+r.Host || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unavailable", http.StatusInternalServerError)
		return
	}
	changes, stop := d.discovery.subscribe()
	defer stop()
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	d.lastSeen.Store(time.Now().Unix())
	send := func() bool {
		_, err := fmt.Fprint(w, "data: changed\n\n")
		if err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !send() {
		return
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-d.discovery.ctx.Done():
			return
		case <-changes:
			if !send() {
				return
			}
		}
	}
}
