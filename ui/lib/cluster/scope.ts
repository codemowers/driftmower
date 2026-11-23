import type { ClusterResource } from "./cluster-state"
import type { ImageUsage, Issue } from "./reports"
import { compareIssues, type WorkloadIssue } from "./issues.ts"

// Where a findings block applies. Every block takes the same scope so the
// cluster, namespace, workload and Pod views render the same findings.
export type FindingScope =
  | { kind: "cluster" }
  | { kind: "namespace"; namespace: string }
  | { kind: "workload"; uid: string }
  | { kind: "pod"; namespace: string; name: string; workloadUid?: string }

export function scopeKey(scope: FindingScope): string {
  switch (scope.kind) {
    case "cluster": return "cluster"
    case "namespace": return `namespace/${scope.namespace}`
    case "workload": return `workload/${scope.uid}`
    case "pod": return `pod/${scope.namespace}/${scope.name}`
  }
}

// Running image usages within the scope. A Pod whose own usages are not in
// the report yet falls back to its workload's images.
export function scopeUsages(usages: ImageUsage[], scope: FindingScope): ImageUsage[] {
  const running = usages.filter(u => !u.finished)
  switch (scope.kind) {
    case "cluster": return running
    case "namespace": return running.filter(u => u.namespace === scope.namespace)
    case "workload": return running.filter(u => u.workloadRootInfo?.uid === scope.uid)
    case "pod": {
      const own = running.filter(u => u.namespace === scope.namespace && u.podName === scope.name)
      if (own.length > 0 || !scope.workloadUid) return own
      return running.filter(u => u.workloadRootInfo?.uid === scope.workloadUid)
    }
  }
}

// Pods within the scope, used to aggregate the already evaluated Pod issues.
export function scopePods(resources: ClusterResource[], scope: FindingScope, workloadPods?: ClusterResource[]): ClusterResource[] {
  const pods = resources.filter(r => r.kind === "Pod")
  switch (scope.kind) {
    case "cluster": return pods
    case "namespace": return pods.filter(p => p.namespace === scope.namespace)
    case "workload": return workloadPods ?? []
    case "pod": return pods.filter(p => p.namespace === scope.namespace && p.name === scope.name)
  }
}

// One row per distinct issue, counting the Pods that report it.
export function aggregateIssues(pods: ClusterResource[], extra: WorkloadIssue[] = []): WorkloadIssue[] {
  const byKey = new Map<string, WorkloadIssue>()
  for (const issue of extra) byKey.set(`${issue.code}:${issue.message}`, issue)
  const seen = new Set<string>()
  for (const pod of pods) {
    if (seen.has(pod.uid)) continue
    seen.add(pod.uid)
    for (const issue of pod.issues ?? []) {
      const key = `${issue.code}:${issue.message}`
      const existing = byKey.get(key)
      byKey.set(key, { ...issue, podCount: (existing?.podCount ?? 0) + 1 })
    }
  }
  return [...byKey.values()].sort(compareIssues)
}

// Image metadata issues (registry scraping, digest verification) for the
// images running within the scope.
export function scopeImageIssues(issues: Issue[], usages: ImageUsage[]): Issue[] {
  return issues.filter(i => usages.some(u => u.image.includes(i.image)))
}
