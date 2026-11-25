package dashboard

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func (d *ContextDiscovery) loadingRules() *clientcmd.ClientConfigLoadingRules {
	rules := clientcmd.NewDefaultClientConfigLoadingRules()
	if d.path != "" {
		rules.ExplicitPath = d.path
	}
	return rules
}
func (d *ContextDiscovery) kubeconfigPaths() []string {
	seen := map[string]bool{}
	var paths []string
	for _, name := range d.loadingRules().GetLoadingPrecedence() {
		absolute, err := filepath.Abs(name)
		if err != nil {
			continue
		}
		if !seen[absolute] {
			paths = append(paths, absolute)
			seen[absolute] = true
		}
		if resolved, err := filepath.EvalSymlinks(absolute); err == nil && !seen[resolved] {
			paths = append(paths, resolved)
			seen[resolved] = true
		}
	}
	return paths
}
func (d *ContextDiscovery) publishGroups(raw *clientcmdapi.Config, generation uint64) ([]DiscoveredContext, bool) {
	results := contextGroups(raw, d.browserKind())
	d.mu.Lock()
	if generation != d.generation.Load() {
		d.mu.Unlock()
		return nil, false
	}
	for i, group := range results {
		for _, previous := range d.contexts {
			if previous.Key == group.Key {
				results[i].Status, results[i].State, results[i].URL, results[i].PortForward = previous.Status, previous.State, previous.URL, previous.PortForward
				break
			}
		}
	}
	d.contexts = results
	d.mu.Unlock()
	d.notify()
	return results, true
}
func (d *ContextDiscovery) kubeconfigChanged() {
	generation := d.generation.Add(1)
	raw, err := d.load()
	if err != nil {
		d.mu.Lock()
		d.contexts = []DiscoveredContext{{Name: "kubeconfig", Status: "Cannot read kubeconfig"}}
		d.mu.Unlock()
		d.notify()
	} else {
		d.publishGroups(raw, generation)
	}
	select {
	case d.wake <- struct{}{}:
	default:
	}
}

// Watch directories, not file inodes: editors and kubectl replace kubeconfigs
// atomically. Watch ancestors too so a missing/deleted parent can be recreated.
func (d *ContextDiscovery) startKubeconfigWatcher() {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		d.setWatchError(err)
		close(d.watchDone)
		return
	}
	paths := d.kubeconfigPaths()
	rebuild := func() error {
		paths = d.kubeconfigPaths()
		desired := map[string]bool{}
		for _, name := range paths {
			parent := filepath.Dir(name)
			for {
				info, err := os.Stat(parent)
				if err == nil && info.IsDir() {
					break
				}
				next := filepath.Dir(parent)
				if next == parent {
					break
				}
				parent = next
			}
			desired[parent] = true
			desired[filepath.Dir(parent)] = true
		}
		present := map[string]bool{}
		for _, name := range watcher.WatchList() {
			if desired[name] {
				present[name] = true
			} else {
				_ = watcher.Remove(name)
			}
		}
		for name := range desired {
			if !present[name] {
				if err := watcher.Add(name); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := rebuild(); err != nil {
		d.setWatchError(err)
		_ = watcher.Close()
		close(d.watchDone)
		return
	}
	go func() {
		defer close(d.watchDone)
		defer func() { _ = watcher.Close() }()
		var timer *time.Timer
		var changed <-chan time.Time
		defer func() {
			if timer != nil {
				timer.Stop()
			}
		}()
		for {
			select {
			case <-d.ctx.Done():
				return
			case event, ok := <-watcher.Events:
				if !ok {
					return
				}
				relevant := false
				for _, name := range paths {
					if name == event.Name || strings.HasPrefix(name, event.Name+string(os.PathSeparator)) {
						relevant = true
						break
					}
				}
				if !relevant {
					continue
				}
				if timer == nil {
					timer = time.NewTimer(75 * time.Millisecond)
				} else {
					timer.Reset(75 * time.Millisecond)
				}
				changed = timer.C
			case _, ok := <-watcher.Errors:
				if !ok {
					return
				}
				// Overflow can lose events: reload once, driven by that error rather than polling.
				d.kubeconfigChanged()
				d.setWatchError(rebuild())
			case <-changed:
				changed = nil
				d.kubeconfigChanged()
				d.setWatchError(rebuild())
			}
		}
	}()
}
