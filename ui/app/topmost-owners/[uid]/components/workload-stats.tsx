import type { StatusType } from "@/lib/cluster/reports"
import { staleText } from "@/lib/cluster/styles/status-style"
import {
  StatGrid,
  StatCell,
  StatValue,
  StatCaption,
  DriftScoreCell,
} from "@/app/components/stats-card"
import RuntimeCell from "@/app/components/runtime-cell"
import type { ClusterResource } from "@/lib/cluster/cluster-state"

type Props = {
  normalizedScore: number
  staleRepoCount: number
  distinctRepoCount: number
  totalContainers: number
  totalPods: number
  worstStatus: StatusType
  pods: ClusterResource[]
  // Kinds meant to run as interchangeable replicas.
  replicated: boolean
}

export default function WorkloadStats({
  normalizedScore,
  staleRepoCount,
  distinctRepoCount,
  totalContainers,
  totalPods,
  worstStatus,
  pods,
  replicated,
}: Props) {
  const podLabel = totalPods === 1 ? "1 pod" : `${totalPods} pods`

  return (
    <StatGrid>
      <DriftScoreCell worstStatus={worstStatus} normalizedScore={normalizedScore} />

      <StatCell label="Stale Repos">
        <StatValue className={staleText(staleRepoCount, distinctRepoCount)}>
          {staleRepoCount} / {distinctRepoCount}
        </StatValue>
        <StatCaption>image repositories</StatCaption>
      </StatCell>

      <StatCell label="Containers">
        <StatValue>{totalContainers}</StatValue>
        <StatCaption>in {podLabel}</StatCaption>
      </StatCell>

      <RuntimeCell pods={pods} replicated={replicated} />
    </StatGrid>
  )
}
