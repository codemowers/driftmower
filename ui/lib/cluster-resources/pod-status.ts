import "server-only"

import type { PodContainerStatus, PodStatus } from "@/lib/cluster/cluster-state"

export type ContainerStatus = {
  name?: string
  image?: string
  ready?: boolean
  restartCount?: number
  state?: {
    waiting?: { reason?: string; message?: string }
    terminated?: { reason?: string; exitCode?: number }
  }
  lastState?: {
    terminated?: { reason?: string; exitCode?: number; finishedAt?: string }
  }
}

export type RawPodStatus = {
  phase?: string
  reason?: string
  message?: string
  containerStatuses?: ContainerStatus[]
  initContainerStatuses?: ContainerStatus[]
}

export function derivePodStatus(
  deletionTimestamp: string | undefined,
  status: RawPodStatus | undefined,
): PodStatus {
  const containers = status?.containerStatuses ?? []
  const initContainers = status?.initContainerStatuses ?? []
  return {
    display: podDisplayStatus(deletionTimestamp, status, containers, initContainers),
    ready: containers.length > 0 && containers.every(c => c.ready),
    restarts: [...initContainers, ...containers].reduce((sum, c) => sum + (c.restartCount ?? 0), 0),
    message: status?.message ?? null,
    containers: [
      ...initContainers.map(c => toContainerStatus(c, true)),
      ...containers.map(c => toContainerStatus(c, false)),
    ],
  }
}

function toContainerStatus(c: ContainerStatus, init: boolean): PodContainerStatus {
  const waiting = c.state?.waiting
  const terminated = c.lastState?.terminated
  return {
    name: c.name ?? "",
    image: c.image ?? "",
    init,
    ready: c.ready ?? false,
    restartCount: c.restartCount ?? 0,
    waiting: waiting?.reason ? { reason: waiting.reason, message: waiting.message ?? null } : null,
    lastTerminated: terminated
      ? { exitCode: terminated.exitCode ?? 0, reason: terminated.reason ?? "Error", finishedAt: terminated.finishedAt ?? null }
      : null,
  }
}

function podDisplayStatus(
  deletionTimestamp: string | undefined,
  status: RawPodStatus | undefined,
  containers: ContainerStatus[],
  initContainers: ContainerStatus[],
): string {
  if (deletionTimestamp) return "Terminating"
  if (status?.reason) return status.reason

  for (const c of initContainers) {
    const waiting = c.state?.waiting?.reason
    if (waiting && waiting !== "PodInitializing") return `Init:${waiting}`
    const terminated = c.state?.terminated
    if (terminated && terminated.exitCode !== 0) return `Init:${terminated.reason ?? "Error"}`
  }

  for (const c of containers) {
    const waiting = c.state?.waiting?.reason
    if (waiting) return waiting
  }
  for (const c of containers) {
    const terminated = c.state?.terminated
    if (terminated && terminated.exitCode !== 0) return terminated.reason ?? "Error"
  }

  if (status?.phase === "Succeeded") return "Completed"
  return status?.phase ?? "Unknown"
}
