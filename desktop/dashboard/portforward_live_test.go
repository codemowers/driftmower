package dashboard

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"k8s.io/client-go/tools/clientcmd"
)

// Explicit opt-in: reads the selected context and opens a local tunnel. It
// never modifies cluster resources or invokes an interactive credential plugin.
func TestDesktopForwardLive(t *testing.T) {
	name := os.Getenv("DRIFTMOWER_TEST_FORWARD_CONTEXT")
	if name == "" {
		t.Skip("live port-forward check is opt-in")
	}
	raw, err := clientcmd.NewDefaultClientConfigLoadingRules().Load()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	d := StartDiscovery(false, "", true)
	defer d.Close()
	var key string
	for _, group := range contextGroups(raw) {
		for _, alias := range group.Aliases {
			if alias.Name == name {
				key = group.Key
			}
		}
	}
	if key == "" {
		t.Fatal("context not found")
	}
	reachable := func(server string) error { return dial(ctx, server) }
	result := d.inspectContext(raw, name, key, reachable)
	if result.Status != "available" || !result.PortForward {
		t.Fatalf("context: %+v", result)
	}
	again := d.inspectContext(raw, name, key, reachable)
	if again.URL != result.URL {
		t.Fatal("refresh replaced a working tunnel")
	}
	client, err := mcp.NewClient(&mcp.Implementation{Name: "desktop-forward-check", Version: "test"}, nil).Connect(ctx, &mcp.StreamableClientTransport{Endpoint: result.URL, DisableStandaloneSSE: true, MaxRetries: -1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	response, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "list_accessible_namespaces", Arguments: map[string]any{}})
	if err != nil || response.IsError {
		t.Fatalf("namespace read failed: %v %+v", err, response)
	}
	data, _ := json.Marshal(response.StructuredContent)
	var inventory struct {
		Namespaces []string `json:"namespaces"`
	}
	if err := json.Unmarshal(data, &inventory); err != nil || len(inventory.Namespaces) == 0 {
		t.Fatalf("empty namespace response: %v", err)
	}
	t.Logf("%s: automatic desktop tunnel %s, %d namespaces", name, result.URL, len(inventory.Namespaces))
	client.Close()
	d.Close()
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, result.URL, nil)
	if response, err := http.DefaultClient.Do(request); err == nil {
		response.Body.Close()
		t.Fatal("desktop shutdown left tunnel reachable")
	}
}
