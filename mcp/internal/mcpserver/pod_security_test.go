package mcpserver

import (
	"slices"
	"testing"

	corev1 "k8s.io/api/core/v1"
)

func TestAnalyzePodSecurity(t *testing.T) {
	kata, zero, uid, yes, no := "kata", int64(0), int64(1000), true, false
	for name, tc := range map[string]struct {
		pod  corev1.PodSpec
		want podSecurity
	}{
		"image default":  {corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}}, podSecurity{User: "image"}},
		"user namespace": {corev1.PodSpec{HostUsers: &no, Containers: []corev1.Container{{Name: "app"}}}, podSecurity{User: "image", UserNamespace: true}},
		"pod non-root":   {corev1.PodSpec{SecurityContext: &corev1.PodSecurityContext{RunAsNonRoot: &yes}, Containers: []corev1.Container{{Name: "app"}}}, podSecurity{User: "nonroot"}},
		"container uid overrides pod": {corev1.PodSpec{
			SecurityContext: &corev1.PodSecurityContext{RunAsUser: &uid},
			Containers:      []corev1.Container{{Name: "a"}, {Name: "b", SecurityContext: &corev1.SecurityContext{RunAsUser: &zero}}},
		}, podSecurity{User: "root"}},
		"kata privileged": {corev1.PodSpec{
			RuntimeClassName: &kata, HostNetwork: true,
			Containers: []corev1.Container{{Name: "app", SecurityContext: &corev1.SecurityContext{RunAsUser: &uid, Privileged: &yes,
				Capabilities: &corev1.Capabilities{Add: []corev1.Capability{"NET_ADMIN"}}}}},
		}, podSecurity{RuntimeClassName: "kata", Sandboxed: true, User: "nonroot", Privileged: []string{"app"}, HostNamespaces: []string{"hostNetwork"}, AddedCapabilities: []string{"NET_ADMIN"}}},
	} {
		got := analyzePodSecurity(&corev1.Pod{Spec: tc.pod})
		if got.User != tc.want.User || got.UserNamespace != tc.want.UserNamespace || got.Sandboxed != tc.want.Sandboxed || got.RuntimeClassName != tc.want.RuntimeClassName ||
			!slices.Equal(got.Privileged, tc.want.Privileged) || !slices.Equal(got.HostNamespaces, tc.want.HostNamespaces) || !slices.Equal(got.AddedCapabilities, tc.want.AddedCapabilities) {
			t.Errorf("%s: got %+v, want %+v", name, got, tc.want)
		}
	}
}
