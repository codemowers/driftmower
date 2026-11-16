package dashboard

import (
	"encoding/json"
	"net/http"
	"net/url"
)

func (d *Dashboard) setChromeProfile(w http.ResponseWriter, r *http.Request) {
	if !sameOriginLoopback(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var body struct {
		Key       string `json:"key"`
		Directory string `json:"directory"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.Key == "" {
		http.Error(w, "connection required", 400)
		return
	}
	if err := d.cfg.ChromeProfiles.Set(d.discovery, body.Key, body.Directory); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (d *Dashboard) openChromeConnection(w http.ResponseWriter, r *http.Request) {
	if !sameOriginLoopback(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var body struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.Key == "" {
		http.Error(w, "connection required", 400)
		return
	}
	contexts, _ := d.discovery.Snapshot()
	for _, connection := range contexts {
		if connection.Key != body.Key {
			continue
		}
		if connection.ChromeProfile == nil {
			http.Error(w, "choose a Chrome profile first", 400)
			return
		}
		profiles, err := d.cfg.ChromeProfiles.List()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		found := false
		for _, profile := range profiles {
			if profile.Directory == connection.ChromeProfile.Directory {
				found = true
			}
		}
		if !found {
			http.Error(w, "assigned Chrome profile no longer exists", 409)
			return
		}
		d.discovery.Retry(connection.Key)
		query := url.Values{"connect": {body.Key}, "chrome-profile": {connection.ChromeProfile.Directory}}
		target := DesktopOrigin + "/settings?" + query.Encode()
		if err := d.cfg.ChromeProfiles.launch(connection.ChromeProfile.Directory, target, true); err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	http.Error(w, "connection no longer exists", 404)
}

// Retry refreshes discovery without opening an interactive credential prompt.
func (d *ContextDiscovery) Retry(key string) bool {
	d.mu.Lock()
	found := false
	for i := range d.contexts {
		if d.contexts[i].Key == key {
			d.contexts[i].Status = "checking"
			found = true
			break
		}
	}
	d.mu.Unlock()
	if found {
		select {
		case d.wake <- struct{}{}:
		default:
		}
	}
	return found
}
func (d *Dashboard) retryConnection(w http.ResponseWriter, r *http.Request) {
	if !sameOriginLoopback(r) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var body struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil || body.Key == "" {
		http.Error(w, "connection required", 400)
		return
	}
	if !d.discovery.Retry(body.Key) {
		http.Error(w, "connection no longer exists", 404)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
