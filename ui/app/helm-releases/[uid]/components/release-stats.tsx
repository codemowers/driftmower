import type { StatusType } from "@/lib/cluster/reports"
import { staleText } from "@/lib/cluster/styles/status-style"
import { shortDate } from "@/lib/utils/format-time"
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
  namespace: string
  worstStatus: StatusType
  installedAt?: string
  upgradedAt?: string
  revision?: number
}

export default function ReleaseStats({
  normalizedScore,
  staleRepoCount,
  distinctRepoCount,
  namespace,
  worstStatus,
  installedAt,
  upgradedAt,
  revision,
}: Props) {
  const upgradeCaptionParts = [
    installedAt ? `installed ${shortDate(installedAt)}` : null,
    revision !== undefined ? `revision ${revision}` : null,
  ].filter(Boolean)

  return (
    <StatGrid>
      <DriftScoreCell worstStatus={worstStatus} normalizedScore={normalizedScore} />

      <StatCell label="Stale Repos">
        <StatValue className={staleText(staleRepoCount, distinctRepoCount)}>
          {staleRepoCount} / {distinctRepoCount}
        </StatValue>
        <StatCaption>image repositories</StatCaption>
      </StatCell>

      <StatCell label="Last Upgraded">
        <StatValue className="font-sans">{upgradedAt ? shortDate(upgradedAt) : "—"}</StatValue>
        {upgradeCaptionParts.length > 0 && <StatCaption>{upgradeCaptionParts.join(" · ")}</StatCaption>}
      </StatCell>

      <NamespaceCell namespace={namespace} worstStatus={worstStatus} />
    </StatGrid>
  )
}
