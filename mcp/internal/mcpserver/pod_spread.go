package mcpserver

import (
	corev1 "k8s.io/api/core/v1"
)

// podSpread is one rule that keeps a workload's Pods apart: a topology spread
// constraint or a pod anti-affinity term, by the topology key it spreads
// over. Hard rules block scheduling; soft ones only prefer.
type podSpread struct {
	Kind        string `json:"kind"`
	TopologyKey string `json:"topologyKey"`
	Hard        bool   `json:"hard"`
}

func analyzePodSpread(spec *corev1.PodSpec) []podSpread {
	out := []podSpread{}
	for _, c := range spec.TopologySpreadConstraints {
		out = append(out, podSpread{Kind: "topologySpreadConstraint", TopologyKey: c.TopologyKey, Hard: c.WhenUnsatisfiable == corev1.DoNotSchedule})
	}
	if spec.Affinity == nil || spec.Affinity.PodAntiAffinity == nil {
		return out
	}
	for _, term := range spec.Affinity.PodAntiAffinity.RequiredDuringSchedulingIgnoredDuringExecution {
		out = append(out, podSpread{Kind: "podAntiAffinity", TopologyKey: term.TopologyKey, Hard: true})
	}
	for _, term := range spec.Affinity.PodAntiAffinity.PreferredDuringSchedulingIgnoredDuringExecution {
		out = append(out, podSpread{Kind: "podAntiAffinity", TopologyKey: term.PodAffinityTerm.TopologyKey})
	}

	return out
}
