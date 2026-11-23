import type { ReactNode } from "react"
import { staleText } from "@/lib/cluster/styles/status-style"
import {
  StatGrid,
  StatCell,
  StatValue,
  StatCaption,
} from "@/app/components/stats-card"

type Props = {
  staleRepoCount: number
  distinctRepoCount: number
  totalContainers: number
  totalPods: number
  provenance?: ReactNode
}

export default function WorkloadStats({
  staleRepoCount,
  distinctRepoCount,
  totalContainers,
  totalPods,
  provenance,
}: Props) {
  const podLabel = totalPods === 1 ? "1 pod" : `${totalPods} pods`

  return (
    <StatGrid columns={3} vertical>
      {provenance && <StatCell label="Provenance">{provenance}</StatCell>}

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

    </StatGrid>
  )
}
