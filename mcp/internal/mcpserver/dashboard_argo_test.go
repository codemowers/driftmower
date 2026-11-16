package mcpserver

import (
	"reflect"
	"testing"
)

func TestArgoApplicationFromTrackingID(t *testing.T) {
	const tree = "?view=tree&orphaned=false&resource=&node="
	for _, tc := range []struct {
		id, url string
		want    map[string]any
	}{
		{"shop:apps/Deployment:shop/web", "https://argo.example.com/", map[string]any{"name": "shop", "kind": "Deployment", "resourceRef": "shop/web",
			"url":        "https://argo.example.com/applications/argocd/shop" + tree + "apps%2FDeployment%2Fshop%2Fweb%2F0",
			"detailsUrl": "https://argo.example.com/applications/argocd/shop" + tree + "argoproj.io%2FApplication%2Fargocd%2Fshop%2F0"}},
		{"team_shop:/Service:shop/web", "https://argo.example.com", map[string]any{"name": "team_shop", "kind": "Service", "resourceRef": "shop/web",
			"url":        "https://argo.example.com/applications/team/shop" + tree + "%2FService%2Fshop%2Fweb%2F0",
			"detailsUrl": "https://argo.example.com/applications/team/shop" + tree + "argoproj.io%2FApplication%2Fteam%2Fshop%2F0"}},
		{"shop:apps/Deployment:shop/web", "", map[string]any{"name": "shop", "kind": "Deployment", "resourceRef": "shop/web"}},
	} {
		if got := argoApplication(tc.id, tc.url); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("argoApplication(%q) = %v, want %v", tc.id, got, tc.want)
		}
	}
	if got := argoApplication("", "https://argo.example.com"); got != nil {
		t.Errorf("empty tracking ID = %v", got)
	}
}
