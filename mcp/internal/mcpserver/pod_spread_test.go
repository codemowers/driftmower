package mcpserver

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
)

func TestAnalyzePodSpread(t *testing.T) {
	spec := &corev1.PodSpec{
		TopologySpreadConstraints: []corev1.TopologySpreadConstraint{{TopologyKey: "topology.kubernetes.io/zone", WhenUnsatisfiable: corev1.ScheduleAnyway}},
		Affinity: &corev1.Affinity{PodAntiAffinity: &corev1.PodAntiAffinity{
			RequiredDuringSchedulingIgnoredDuringExecution: []corev1.PodAffinityTerm{{TopologyKey: "kubernetes.io/hostname"}},
		}},
	}
	got := analyzePodSpread(spec)
	if len(got) != 2 || got[0].Hard || got[0].TopologyKey != "topology.kubernetes.io/zone" || !got[1].Hard || got[1].Kind != "podAntiAffinity" {
		t.Fatalf("%+v", got)
	}
	if len(analyzePodSpread(&corev1.PodSpec{})) != 0 {
		t.Fatal("empty spec spreads")
	}
}
