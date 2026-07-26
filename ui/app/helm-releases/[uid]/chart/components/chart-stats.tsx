import type { StatusType } from "@/lib/cluster/reports"
import { shortDate } from "@/lib/utils/format-time"
import { StatGrid, StatCell, StatValue, StatCaption } from "@/app/components/stats-card"

type Props = {
  deployed?: string
  latest?: string
  appVersion?: string
  revision?: number
  drift: StatusType
  behindCount: number
  patchUpdate: string | null
  hasTags: boolean
  helmStatus?: string
  installedAt?: string
  upgradedAt?: string
}

function latestCaption(drift: StatusType, behindCount: number): string {
  if (drift === "up_to_date") return "deployed chart is current"
  if (drift === "ahead") return "deployed is ahead of the source"
  if (drift === "no_data") return "no version data from the source"
  return `${behindCount} stable version${behindCount === 1 ? "" : "s"} ahead of deployed`
}

export default function ChartStats({
  deployed,
  latest,
  appVersion,
  revision,
  drift,
  behindCount,
  patchUpdate,
  hasTags,
  helmStatus,
  installedAt,
  upgradedAt,
}: Props) {
  const deployedCaptionParts = [
    appVersion ? `app ${appVersion}` : null,
    revision !== undefined ? `revision ${revision}` : null,
  ].filter(Boolean)

  const dateParts = [
    installedAt ? `installed ${shortDate(installedAt)}` : null,
    upgradedAt ? `upgraded ${shortDate(upgradedAt)}` : null,
  ].filter(Boolean)

  const statusChip = helmStatus
    ? helmStatus === "deployed"
      ? "bg-status-ok-bg text-status-ok-label"
      : "bg-status-minor-bg text-status-minor-label"
    : "bg-gray-100 text-muted-foreground"

  return (
    <StatGrid>
      <StatCell label="Deployed Version">
        <StatValue className="font-mono">{deployed ?? "—"}</StatValue>
        {deployedCaptionParts.length > 0 && <StatCaption>{deployedCaptionParts.join(" · ")}</StatCaption>}
      </StatCell>

      <StatCell label="Latest Version">
        {latest
          ? <StatValue className="font-mono">{latest}</StatValue>
          : <p className="text-xl font-medium text-foreground mt-0.5">no data</p>}
        <StatCaption>{latestCaption(drift, behindCount)}</StatCaption>
      </StatCell>

      <StatCell label="Patch Update">
        {patchUpdate
          ? <StatValue className="font-mono">{patchUpdate}</StatValue>
          : <p className="text-xl font-medium text-foreground mt-0.5">{hasTags ? "none" : "no data"}</p>}
        <StatCaption>
          {patchUpdate
            ? "newest patch of the deployed minor"
            : hasTags
              ? "deployed minor is patch-current"
              : "no version data from the source"}
        </StatCaption>
      </StatCell>

      <StatCell label="Release">
        <div className="mt-1">
          <span className={`rounded-md px-2.5 py-1 text-xs font-semibold ${statusChip}`}>
            {helmStatus ?? "unknown"}
          </span>
        </div>
        {dateParts.length > 0 && <StatCaption>{dateParts.join(" · ")}</StatCaption>}
      </StatCell>
    </StatGrid>
  )
}
