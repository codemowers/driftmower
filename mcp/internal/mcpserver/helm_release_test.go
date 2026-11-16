package mcpserver

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
	metadatafake "k8s.io/client-go/metadata/fake"

	"github.com/codemowers/driftmower/mcp/internal/authz"
	"github.com/codemowers/driftmower/mcp/internal/workloads"
)

type verdictJudge func(authz.Attributes) authz.Verdict

func (f verdictJudge) MayPerform(_ context.Context, _ authz.Identity, a authz.Attributes) authz.Judgement {
	return authz.Judgement{Verdict: f(a)}
}

func helmReleasePayload(t *testing.T) []byte {
	t.Helper()
	release := map[string]any{
		"name": "web", "namespace": "apps", "version": 2, "info": map[string]any{"status": "deployed"},
		"config":   map[string]any{"replicas": 2, "db": map[string]any{"password": "hunter2", "existingSecret": "db-creds"}},
		"chart":    map[string]any{"metadata": map[string]any{"name": "web", "version": "1.2.3", "appVersion": "4.5"}, "values": map[string]any{"replicas": 1, "apiToken": ""}},
		"manifest": "---\n# Source: web/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: web\ndata:\n  key: c2VjcmV0\n---\n# Source: web/templates/svc.yaml\napiVersion: v1\nkind: Service\nmetadata:\n  name: web\n",
	}
	raw, _ := json.Marshal(release)
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write(raw)
	_ = zw.Close()

	return []byte(base64.StdEncoding.EncodeToString(gz.Bytes()))
}

func TestReadHelmReleaseRedactsAndChecksSecretAccess(t *testing.T) {
	ctx := context.Background()
	labels := func(rev, status string) map[string]string {
		return map[string]string{"owner": "helm", "name": "web", "version": rev, "status": status}
	}
	k := fake.NewClientset(
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "sh.helm.release.v1.web.v2", Namespace: "apps", Labels: labels("2", "deployed")}, Data: map[string][]byte{"release": helmReleasePayload(t)}},
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "sh.helm.release.v1.web.v3", Namespace: "apps", Labels: labels("3", "failed")}},
	)
	scheme := metadatafake.NewTestScheme()
	_ = metav1.AddMetaToScheme(scheme)
	meta := func(rev, status string) *metav1.PartialObjectMetadata {
		return &metav1.PartialObjectMetadata{TypeMeta: metav1.TypeMeta{APIVersion: "v1", Kind: "Secret"}, ObjectMeta: metav1.ObjectMeta{Name: "sh.helm.release.v1.web.v" + rev, Namespace: "apps", Labels: labels(rev, status)}}
	}
	var asked []string
	w := &Workloads{Metadata: metadatafake.NewSimpleMetadataClient(scheme, meta("2", "deployed"), meta("3", "failed")), Cache: &workloads.Cache{Kubernetes: k},
		Judge: verdictJudge(func(a authz.Attributes) authz.Verdict {
			asked = append(asked, a.Verb+" "+a.Resource+" "+a.Name)
			if a.Verb == "get" && a.Resource == "secrets" && a.Name == "sh.helm.release.v1.web.v2" {
				return authz.Yes
			}

			return authz.No
		})}

	out, err := readHelmRelease(ctx, w, authz.Identity{}, "apps", "web")
	if err != nil {
		t.Fatal(err)
	}
	if out.Revision != 2 || out.ChartVersion != "1.2.3" || len(out.Documents) != 2 || out.Documents[0].Kind != "Secret" || out.Documents[0].Source != "web/templates/secret.yaml" || out.Documents[1].Name != "web" {
		t.Fatalf("release = %+v", out)
	}
	raw, _ := json.Marshal(out)
	if strings.Contains(string(raw), "hunter2") || strings.Contains(string(raw), "c2VjcmV0") || !strings.Contains(string(raw), "db-creds") {
		t.Fatalf("redaction: %s", raw)
	}
	if len(asked) != 1 || asked[0] != "get secrets sh.helm.release.v1.web.v2" {
		t.Fatalf("authorization asked %v", asked)
	}

	w.Judge = verdictJudge(func(authz.Attributes) authz.Verdict { return authz.No })
	if _, err := readHelmRelease(ctx, w, authz.Identity{}, "apps", "web"); err == nil || !strings.Contains(err.Error(), "not authorized") {
		t.Fatalf("denied caller: %v", err)
	}
}
