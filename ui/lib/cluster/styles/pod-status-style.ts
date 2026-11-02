import type { ClusterResource } from "@/lib/cluster/cluster-state"

export type PodSeverity = "failed" | "unknown" | "pending" | "healthy" | "succeeded"

export type PodSeverityStyle = { label: string; solid: string; square: string; bg: string; text: string }

export const POD_SEVERITY_STYLE: Record<PodSeverity, PodSeverityStyle> = {
  failed:    { label: "Failed",    solid: "bg-status-major",   square: "bg-status-major-bg border-status-major",     bg: "bg-status-major-bg",   text: "text-status-major-label" },
  unknown:   { label: "Unknown",   solid: "bg-status-minor",   square: "bg-status-minor-bg border-status-minor",     bg: "bg-status-minor-bg",   text: "text-status-minor-label" },
  pending:   { label: "Pending",   solid: "bg-status-patch",   square: "bg-status-patch-bg border-status-patch",     bg: "bg-status-patch-bg",   text: "text-status-patch-label" },
  healthy:   { label: "Healthy",   solid: "bg-status-ok",      square: "bg-status-ok-bg border-status-ok",           bg: "bg-status-ok-bg",      text: "text-status-ok-label" },
  succeeded: { label: "Completed", solid: "bg-status-neutral", square: "bg-status-neutral-bg border-status-neutral", bg: "bg-status-neutral-bg", text: "text-status-neutral-label" },
}

export const POD_SQUARE_ORDER: PodSeverity[] = ["failed", "unknown", "pending", "healthy", "succeeded"]

export const POD_SORT_ORDER: PodSeverity[] = ["failed", "unknown", "pending"]

const FAILED_REASONS = new Set([
  "CrashLoopBackOff",
  "ImagePullBackOff",
  "ErrImagePull",
  "OOMKilled",
  "Error",
  "CreateContainerConfigError",
  "CreateContainerError",
  "RunContainerError",
  "Evicted",
])

export function podStateLabel(severity: PodSeverity, display: string | undefined): string {
  if (severity === "healthy") return POD_SEVERITY_STYLE.healthy.label
  return display ?? POD_SEVERITY_STYLE[severity].label
}

export function classifyPod(pod: ClusterResource): PodSeverity {
  const display = pod.podStatus?.display ?? pod.phase ?? "Unknown"
  const reason = display.startsWith("Init:") ? display.slice("Init:".length) : display

  if (pod.phase === "Failed" || FAILED_REASONS.has(reason)) return "failed"
  if (pod.phase === "Unknown" || reason === "NodeLost") return "unknown"
  if (pod.phase === "Succeeded") return "succeeded"
  if (pod.phase === "Pending" || display === "Terminating") return "pending"
  if (pod.podStatus && !pod.podStatus.ready) return "pending"
  return "healthy"
}
