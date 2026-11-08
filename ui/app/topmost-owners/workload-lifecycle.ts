import type { WorkloadEntry } from "./focus/types"

type Lifecycle = Pick<WorkloadEntry, "desiredReplicas" | "completed" | "pods">

export function isDownscaled(entry: Lifecycle): boolean {
  // A missing pod is not evidence of an intentional scale-to-zero.
  return entry.desiredReplicas === 0
}

export function isFinished(entry: Lifecycle): boolean {
  if (isDownscaled(entry)) return false
  if (entry.completed) return true
  const pods = entry.pods
  // Includes standalone Pods and custom owners, not just Jobs. Failed or
  // mixed running/completed workloads remain visible for investigation.
  return !!pods && pods.total > 0 && pods.counts.succeeded === pods.total
}
