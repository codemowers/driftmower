package scanner

import (
	"bytes"
	"context"
	"errors"
	"k8s.io/client-go/kubernetes/fake"
	"log/slog"
	"strings"
	"testing"
)

func TestMissingNodestatdDisablesDispatcher(t *testing.T) {
	kube := fake.NewClientset()
	var logs bytes.Buffer
	c := &Controller{Kube: kube, Log: slog.New(slog.NewTextHandler(&logs, nil))}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := c.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if !c.disabled.Load() || c.informer != nil || c.queue != nil {
		t.Fatal("missing APIs started scanner inventory or dispatch")
	}
	if !strings.Contains(logs.String(), "nodestatd is not installed") || !strings.Contains(logs.String(), "helm install nodestatd") {
		t.Fatalf("missing installation warning: %s", logs.String())
	}
	for _, action := range kube.Actions() {
		if action.GetVerb() == "create" {
			t.Fatalf("disabled dispatcher created %s", action.GetResource())
		}
	}
}
