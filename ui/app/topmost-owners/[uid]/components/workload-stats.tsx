import type { StatusType } from "@/lib/cluster/reports"
import { staleText } from "@/lib/cluster/styles/status-style"
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
  totalPods: number
  namespace: string
  worstStatus: StatusType
}

export default function WorkloadStats({
  normalizedScore,
  staleRepoCount,
  distinctRepoCount,
  totalContainers,
  totalPods,
  namespace,
  worstStatus,
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

      <NamespaceCell namespace={namespace} worstStatus={worstStatus} />
    </StatGrid>
  )
}
