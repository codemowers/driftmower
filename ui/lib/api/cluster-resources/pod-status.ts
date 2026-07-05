export type ContainerStatus = {
  ready?: boolean
  restartCount?: number
  state?: {
    waiting?: { reason?: string }
    terminated?: { reason?: string; exitCode?: number }
  }
}

type RawPodStatus = {
  phase?: string
  reason?: string
  containerStatuses?: ContainerStatus[]
  initContainerStatuses?: ContainerStatus[]
}

export type PodStatus = { display: string; ready: boolean; restarts: number }

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
