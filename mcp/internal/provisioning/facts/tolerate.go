// Package facts gathers provisioning facts from the cluster. It is the only
// impure part of the capability layer; everything downstream is a function
// over what it returns.
package facts

import (
	apierrors "k8s.io/apimachinery/pkg/api/errors"

	"github.com/codemowers/driftmower-mcp/internal/provisioning"
)

// unknown is a fact that could not be read. "absent" means the API does not
// serve it; "rbac" means this server was refused. Both must reach the user.
type unknown struct {
	Reason string
	Detail string
}

// tolerate classifies a read error. The ClusterRole and the image roll out
// independently, and half these APIs are CRDs that may not be installed, so a
// 403 or 404 degrades one fact and never fails the answer. Any other error is
// returned. tolerate returns nil, nil for a nil error.
func tolerate(source string, err error) (*unknown, error) {
	switch {
	case err == nil:
		return nil, nil
	case apierrors.IsForbidden(err):
		return &unknown{Reason: "rbac", Detail: "Not authorized to read " + source + " (403). The driftmower-mcp ServiceAccount needs get/list on " + source +
			"; add the rule to chart/templates/observability-rbac.yaml and redeploy."}, nil
	case apierrors.IsNotFound(err):
		return &unknown{Reason: "absent", Detail: "This cluster does not serve " + source + ", so it could not be checked."}, nil
	default:
		return nil, err
	}
}

// degradedList collects the reads worth surfacing. A CRD that is simply not
// installed is a fact, not a failure; only an RBAC refusal needs attention.
type degradedList []provisioning.DegradedRead

func (d *degradedList) note(source string, u *unknown) {
	if u != nil && u.Reason == "rbac" {
		*d = append(*d, provisioning.DegradedRead{Source: source, Status: 403, Message: u.Detail})
	}
}
