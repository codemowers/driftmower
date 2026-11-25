package dashboard

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"

	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
)

type ContextAlias struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
}

func authMethod(auth *clientcmdapi.AuthInfo) (string, bool) {
	if auth == nil {
		return "anonymous", false
	}
	certificate := auth.ClientCertificate != "" || len(auth.ClientCertificateData) > 0
	methods := []string{}
	if certificate {
		methods = append(methods, "certificate")
	}
	if auth.Exec != nil {
		if usesOIDCLogin(auth) {
			methods = append(methods, "oidc")
		} else if kind, ok := cloudPlugin(auth.Exec); ok {
			methods = append(methods, string(kind))
		} else {
			methods = append(methods, "exec")
		}
	} else if auth.AuthProvider != nil {
		methods = append(methods, auth.AuthProvider.Name)
	}
	if auth.Token != "" || auth.TokenFile != "" {
		methods = append(methods, "token")
	}
	if auth.Username != "" || auth.Password != "" {
		methods = append(methods, "basic")
	}
	if len(methods) == 0 {
		methods = append(methods, "anonymous")
	}
	return strings.Join(methods, "+"), certificate
}

// Context identity excludes namespace and kubeconfig entry names. Authentication
// identities (including impersonation) and TLS trust are kept separate, even
// when they reach the same API server. Only an opaque key leaves this process.
// browser selects which browser family's profile assignment is reported;
// an empty browser reports none.
func contextGroups(raw *clientcmdapi.Config, browser Browser) []DiscoveredContext {
	names := make([]string, 0, len(raw.Contexts))
	for name := range raw.Contexts {
		names = append(names, name)
	}
	sort.Strings(names)
	groups := map[string]*DiscoveredContext{}
	for _, name := range names {
		ctx := raw.Contexts[name]
		if ctx == nil || raw.Clusters[ctx.Cluster] == nil {
			groups["invalid:"+name] = &DiscoveredContext{Key: "invalid:" + name, Name: name, Aliases: []ContextAlias{{Name: name}}, Status: "Invalid context configuration", State: "other"}
			continue
		}
		cluster := raw.Clusters[ctx.Cluster].DeepCopy()
		cluster.LocationOfOrigin = ""
		cluster.Extensions = nil
		cluster.Server = strings.TrimRight(cluster.Server, "/")
		auth := raw.AuthInfos[ctx.AuthInfo]
		var identity *clientcmdapi.AuthInfo
		if auth != nil {
			identity = auth.DeepCopy()
			identity.LocationOfOrigin = ""
			identity.Extensions = nil
		}
		jump, jumpErr := jumpHostForCluster(raw.Clusters[ctx.Cluster])
		if jumpErr != nil {
			jump = "invalid:" + name
		}
		encoded, _ := json.Marshal(struct {
			SSHJumpHost string
			Cluster     *clientcmdapi.Cluster
			Auth        *clientcmdapi.AuthInfo
		}{jump, cluster, identity})
		sum := sha256.Sum256(encoded)
		key := hex.EncodeToString(sum[:])
		method, certificate := authMethod(auth)
		group := groups[key]
		if group == nil {
			group = &DiscoveredContext{Key: key, APIServer: cluster.Server, AuthMethod: method, Certificate: certificate, Status: "checking", State: "other", Aliases: []ContextAlias{}}
			groups[key] = group
		}
		group.Aliases = append(group.Aliases, ContextAlias{Name: name, Namespace: ctx.Namespace})
	}
	out := make([]DiscoveredContext, 0, len(groups))
	for _, group := range groups {
		// Prefer a context without a namespace, then the current context, then
		// a stable name. Every scoped alias is still available to command UIs.
		sort.SliceStable(group.Aliases, func(i, j int) bool {
			a, b := group.Aliases[i], group.Aliases[j]
			if (a.Namespace == "") != (b.Namespace == "") {
				return a.Namespace == ""
			}
			if (a.Name == raw.CurrentContext) != (b.Name == raw.CurrentContext) {
				return a.Name == raw.CurrentContext
			}
			return a.Name < b.Name
		})
		group.Name = group.Aliases[0].Name
		if c := raw.Contexts[group.Name]; c != nil {
			if profile, err := browser.profileFor(raw.AuthInfos[c.AuthInfo]); err == nil && profile.Directory != "" {
				group.BrowserProfile = &profile
			}
		}
		out = append(out, *group)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}
