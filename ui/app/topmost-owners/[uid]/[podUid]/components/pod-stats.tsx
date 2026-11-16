import { cn } from "@/lib/utils/cn"
import type { StatusType } from "@/lib/cluster/reports"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import { classifyPod, podStateLabel, POD_SEVERITY_STYLE } from "@/lib/cluster/styles/pod-status-style"
import {
  StatGrid,
  StatCell,
  StatValue,
  StatCaption,
  DriftScoreCell,
} from "@/app/components/stats-card"
import RuntimeCell from "@/app/components/runtime-cell"

type Props = {
  pod: ClusterResource
  nodeName: string
  totalContainers: number
  staleContainerCount: number
  worstStatus: StatusType
  normalizedScore: number
}

export default function PodStats({
  pod,
  nodeName,
  totalContainers,
  staleContainerCount,
  worstStatus,
  normalizedScore,
}: Props) {
  const staleLabel =
    totalContainers === 0
      ? "—"
      : staleContainerCount === 0
        ? "all up to date"
        : `${staleContainerCount} stale`

  const severity = classifyPod(pod)
  const display = podStateLabel(severity, pod.podStatus?.display ?? pod.phase)
  const restarts = pod.podStatus?.restarts ?? 0
  const statusCaption = restarts > 0
    ? `${restarts} ${restarts === 1 ? "restart" : "restarts"} · ${nodeName}`
    : nodeName

  return (
    <StatGrid>
      <DriftScoreCell worstStatus={worstStatus} normalizedScore={normalizedScore} />

      <StatCell label="State">
        <div className="flex items-center gap-2 mt-0.5">
          <span className={cn("size-2 rounded-full", POD_SEVERITY_STYLE[severity].solid)} />
          <p className="text-xl font-semibold text-foreground">{display}</p>
        </div>
        <p className="font-mono text-xs text-muted-foreground truncate" title={statusCaption}>
          {statusCaption}
        </p>
      </StatCell>

      <StatCell label="Containers">
        <StatValue>{totalContainers}</StatValue>
        <StatCaption>{staleLabel}</StatCaption>
      </StatCell>

      <RuntimeCell pods={[pod]} />
    </StatGrid>
  )
}
