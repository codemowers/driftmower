package dashboard

import (
	"encoding/json"
	"strings"
	"testing"

	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

func TestContextGroupsRetainNamespaceAliasesAndSeparateCredentials(t *testing.T) {
	raw := clientcmdapi.NewConfig()
	raw.Clusters["one"] = &clientcmdapi.Cluster{Server: "https://api.example/"}
	raw.Clusters["duplicate-name"] = &clientcmdapi.Cluster{Server: "https://api.example"}
	raw.AuthInfos["cert"] = &clientcmdapi.AuthInfo{ClientCertificateData: []byte("public-cert"), ClientKeyData: []byte("secret-private-key")}
	raw.AuthInfos["same-cert"] = raw.AuthInfos["cert"].DeepCopy()
	raw.AuthInfos["token"] = &clientcmdapi.AuthInfo{Token: "secret-token"}
	raw.AuthInfos["different-token"] = &clientcmdapi.AuthInfo{Token: "another-secret-token"}
	raw.Contexts["admin"] = &clientcmdapi.Context{Cluster: "one", AuthInfo: "cert"}
	raw.Contexts["admin/team"] = &clientcmdapi.Context{Cluster: "duplicate-name", AuthInfo: "same-cert", Namespace: "team"}
	raw.Contexts["user"] = &clientcmdapi.Context{Cluster: "one", AuthInfo: "token"}
	raw.Contexts["user/team"] = &clientcmdapi.Context{Cluster: "one", AuthInfo: "token", Namespace: "team"}
	raw.Contexts["other-user"] = &clientcmdapi.Context{Cluster: "one", AuthInfo: "different-token"}
	raw.CurrentContext = "admin/team"
	groups := contextGroups(raw, "")
	if len(groups) != 3 {
		t.Fatalf("expected three API/auth identities, got %+v", groups)
	}
	var cert *DiscoveredContext
	for i := range groups {
		if groups[i].Certificate {
			cert = &groups[i]
		}
	}
	if cert == nil || cert.Name != "admin" || cert.AuthMethod != "certificate" || len(cert.Aliases) != 2 || cert.Aliases[1].Namespace != "team" {
		t.Fatalf("certificate or aliases lost: %+v", cert)
	}
	body, err := json.Marshal(groups)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), "secret-") {
		t.Fatal("credential data leaked to Settings")
	}
	// Namespace renames do not change the connection's key.
	before := cert.Key
	raw.Contexts["another-namespace"] = &clientcmdapi.Context{Cluster: "one", AuthInfo: "cert", Namespace: "other"}
	for _, group := range contextGroups(raw, "") {
		if group.Certificate && group.Key != before {
			t.Fatal("namespace changed authentication identity")
		}
	}
}

func TestSnapshotKeepsDistinctAuthMethodsAtSameMCPEndpoint(t *testing.T) {
	d := &ContextDiscovery{contexts: []DiscoveredContext{{Key: "cert", Name: "admin", Status: "available", URL: "https://mcp.example/mcp", Certificate: true}, {Key: "oidc", Name: "user", Status: "available", URL: "https://mcp.example/mcp"}}}
	_, endpoints := d.Snapshot()
	if len(endpoints) != 2 || endpoints[0].ContextKey == endpoints[1].ContextKey {
		t.Fatalf("auth methods collapsed by MCP URL: %+v", endpoints)
	}
}
