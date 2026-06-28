import { cn } from "@/lib/utils/cn"
import type { StatusType } from "@/lib/cluster/reports"
import {
  StatGrid,
  StatCell,
  StatValue,
  StatCaption,
  DriftScoreCell,
  NamespaceCell,
} from "@/app/components/stats-card"

type Props = {
  phase: string
  nodeName: string
  totalContainers: number
  staleContainerCount: number
  namespace: string
  worstStatus: StatusType
  normalizedScore: number
}

const PHASE_DOT: Record<string, string> = {
  Running:   "bg-status-ok",
  Pending:   "bg-status-patch",
  Failed:    "bg-status-major",
  Unknown:   "bg-status-major",
  Succeeded: "bg-gray-400",
}

export default function PodStats({
  phase,
  nodeName,
  totalContainers,
  staleContainerCount,
  namespace,
  worstStatus,
  normalizedScore,
}: Props) {
  const staleLabel =
    totalContainers === 0
      ? "—"
      : staleContainerCount === 0
        ? "all up to date"
        : `${staleContainerCount} stale`

  return (
    <StatGrid>
      <DriftScoreCell worstStatus={worstStatus} normalizedScore={normalizedScore} />

      <StatCell label="Phase">
        <div className="flex items-center gap-2 mt-0.5">
          <span className={cn("size-2 rounded-full", PHASE_DOT[phase] ?? "bg-gray-400")} />
          <p className="text-xl font-semibold text-foreground">{phase}</p>
        </div>
        <p className="font-mono text-xs text-muted-foreground truncate" title={nodeName}>
          {nodeName}
        </p>
      </StatCell>

      <StatCell label="Containers">
        <StatValue>{totalContainers}</StatValue>
        <StatCaption>{staleLabel}</StatCaption>
      </StatCell>

      <NamespaceCell namespace={namespace} worstStatus={worstStatus} />
    </StatGrid>
  )
}
