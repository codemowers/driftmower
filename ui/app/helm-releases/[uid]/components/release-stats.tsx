import type { StatusType } from "@/lib/cluster/reports"
import { staleText } from "@/lib/cluster/status-style"
import {
  StatGrid,
  StatCell,
  StatValue,
  StatCaption,
  DriftScoreCell,
  NamespaceCell,
} from "@/app/components/stats-card"

type Props = {
  normalizedScore: number
  staleRepoCount: number
  distinctRepoCount: number
  totalContainers: number
  totalWorkloadCount: number
  namespace: string
  worstStatus: StatusType
}

export default function ReleaseStats({
  normalizedScore,
  staleRepoCount,
  distinctRepoCount,
  totalContainers,
  totalWorkloadCount,
  namespace,
  worstStatus,
}: Props) {
  const workloadLabel = totalWorkloadCount === 1 ? "1 workload" : `${totalWorkloadCount} workloads`

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
        <StatCaption>across {workloadLabel}</StatCaption>
      </StatCell>

      <NamespaceCell namespace={namespace} worstStatus={worstStatus} />
    </StatGrid>
  )
}
