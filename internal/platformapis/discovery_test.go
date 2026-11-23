package platformapis

import (
	"errors"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"testing"
)

type resourceDiscovery struct {
	discovery.DiscoveryInterface
	resources *metav1.APIResourceList
	err       error
}

func (d resourceDiscovery) ServerResourcesForGroupVersion(string) (*metav1.APIResourceList, error) {
	return d.resources, d.err
}

func TestHasResources(t *testing.T) {
	for _, tc := range []struct {
		name          string
		resources     []string
		err           error
		want, wantErr bool
	}{
		{name: "installed", resources: []string{"containerimages", "sourcerepositories"}, want: true},
		{name: "missing images", resources: []string{"sourcerepositories"}},
		{name: "missing sources", resources: []string{"containerimages"}},
		{name: "missing both"},
		{name: "missing API group", err: apierrors.NewNotFound(schema.GroupResource{Group: "codemowers.io", Resource: "v1alpha1"}, "")},
		{name: "forbidden is unknown", err: apierrors.NewForbidden(schema.GroupResource{Resource: "discovery"}, "", errors.New("denied")), wantErr: true},
		{name: "network failure is unknown", err: errors.New("connection refused"), wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			list := &metav1.APIResourceList{}
			for _, name := range tc.resources {
				list.APIResources = append(list.APIResources, metav1.APIResource{Name: name})
			}
			got, err := HasResources(resourceDiscovery{resources: list, err: tc.err}, "codemowers.io/v1alpha1", "containerimages", "sourcerepositories")
			if got != tc.want || (err != nil) != tc.wantErr {
				t.Fatalf("got (%v, %v), want (%v, error=%v)", got, err, tc.want, tc.wantErr)
			}
		})
	}
}
