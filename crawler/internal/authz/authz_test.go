package authz

import (
	"context"
	"testing"

	authzv1 "k8s.io/api/authorization/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func TestMCPUseChecksVerifiedCallerAndRegistration(t *testing.T) {
	for _, allowed := range []bool{false, true} {
		client := fake.NewClientset()
		calls := 0
		client.PrependReactor("create", "subjectaccessreviews", func(action k8stesting.Action) (bool, runtime.Object, error) {
			calls++
			request := action.(k8stesting.CreateAction).GetObject().(*authzv1.SubjectAccessReview)
			r := request.Spec.ResourceAttributes
			if request.Spec.User != "system:serviceaccount:agents:worker" || request.Spec.UID != "uid" || len(request.Spec.Groups) != 1 || r == nil || r.Group != "codemowers.ai" || r.Resource != "clustermcpservers" || r.Name != "driftmower-crawler" || r.Verb != "use" || r.Namespace != "" {
				t.Fatalf("wrong authorization review: %+v", request.Spec)
			}
			return true, &authzv1.SubjectAccessReview{Status: authzv1.SubjectAccessReviewStatus{Allowed: allowed}}, nil
		})
		a := New(client, "driftmower-crawler.driftmower")
		err := a.MayUseMCP(context.Background(), &Identity{User: "system:serviceaccount:agents:worker", UID: "uid", Groups: []string{"system:authenticated"}}, "driftmower-crawler")
		if (err == nil) != allowed || calls != 1 {
			t.Fatalf("allowed=%v err=%v calls=%d", allowed, err, calls)
		}
	}
}
