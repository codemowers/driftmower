package mcpserver

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"k8s.io/apimachinery/pkg/runtime/schema"

	"github.com/codemowers/driftmower/mcp/internal/auth"
	"github.com/codemowers/driftmower/mcp/internal/useraccess"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
)

type ownerRecordInput struct {
	APIVersion string `json:"apiVersion" jsonschema:"apiVersion of the owner, as get_workloads reports it"`
	Kind       string `json:"kind"`
	Namespace  string `json:"namespace"`
	Name       string `json:"name"`
	UID        string `json:"uid" jsonschema:"Rejects a replaced object"`
}

// Owners known only from references are not watched; a page reads one when
// it opens. Answers are kept a minute per caller and object.
const ownerRecordTTL = time.Minute

type ownerRecordEntry struct {
	at     time.Time
	record *ownerRecordOutput
}

type ownerRecordOutput struct {
	workloads.OwnerRecord
	// The account named by codemowers.io/created-by.
	CreatedBy *useraccess.Subject `json:"createdBy,omitempty"`
}

func addOwnerRecordTool(s *mcp.Server, w *Workloads, mapping auth.Mapping) {
	var mu sync.Mutex
	cache := map[string]ownerRecordEntry{}
	mcp.AddTool(s, &mcp.Tool{
		Name:  "get_owner_record",
		Title: "Read a custom-resource owner's record",
		Description: "Read when a workload's top-level owner that get_workloads reports as ownerReferenceOnly was created and last written, by which field manager, and its provenance annotations and labels. " +
			"Read as the caller, so it requires get on that object.",
		InputSchema: inputSchema[ownerRecordInput](func(p map[string]*jsonschema.Schema) {
			for _, k := range []string{"apiVersion", "kind", "namespace", "name", "uid"} {
				p[k].MinLength, p[k].MaxLength = jsonschema.Ptr(1), jsonschema.Ptr(253)
			}
		}),
		Annotations: readOnly("Read a custom-resource owner's record"),
	}, func(ctx context.Context, req *mcp.CallToolRequest, in ownerRecordInput) (*mcp.CallToolResult, *ownerRecordOutput, error) {
		id, err := callerIdentity(req, mapping)
		if err != nil {
			return nil, nil, err
		}
		key := strings.Join(append([]string{id.User, in.APIVersion, in.Kind, in.Namespace, in.Name, in.UID}, id.Groups...), "\x00")
		mu.Lock()
		if e, ok := cache[key]; ok && time.Since(e.at) < ownerRecordTTL {
			mu.Unlock()

			return nil, e.record, nil
		}
		for k, e := range cache {
			if time.Since(e.at) >= ownerRecordTTL {
				delete(cache, k)
			}
		}
		mu.Unlock()
		gvr, err := resourceFor(w, in.APIVersion, in.Kind)
		if err != nil {
			return nil, nil, err
		}
		owner, err := w.Actions.Owner(ctx, id, gvr, in.Namespace, in.Name, in.UID)
		if err != nil {
			return nil, nil, err
		}
		record := &ownerRecordOutput{OwnerRecord: *owner}
		if by := owner.Provenance["codemowers.io/created-by"]; by != "" {
			subject := useraccess.SubjectOf(by, mapping)
			record.CreatedBy = &subject
		}
		mu.Lock()
		cache[key] = ownerRecordEntry{at: time.Now(), record: record}
		mu.Unlock()

		return nil, record, nil
	})
}

// resourceFor finds the namespaced resource serving kind in apiVersion.
func resourceFor(w *Workloads, apiVersion, kind string) (schema.GroupVersionResource, error) {
	gv, err := schema.ParseGroupVersion(apiVersion)
	if err != nil {
		return schema.GroupVersionResource{}, err
	}
	list, err := w.Cache.Discovery.ServerResourcesForGroupVersion(apiVersion)
	if err != nil {
		return schema.GroupVersionResource{}, err
	}
	for _, r := range list.APIResources {
		if r.Kind == kind && r.Namespaced && !strings.Contains(r.Name, "/") {
			return gv.WithResource(r.Name), nil
		}
	}

	return schema.GroupVersionResource{}, errors.New("no namespaced resource serves " + kind + " in " + apiVersion)
}
