import Link from "next/link"
import { ArrowLeft, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import Refreshbutton from "@/app/components/refresh-button"
import CopyButton from "@/app/components/copy-button"
import { cn } from "@/lib/utils"
import type { ReleaseInfo, StatusType } from "@/lib/cluster/reports"

type Props = {
  releaseInfo: ReleaseInfo
  normalizedScore: number
  totalContainers: number
  totalWorkloadCount: number
  worstStatus: StatusType
  issueCount: number
  reportId: string | null
}

const SEVERITY_STYLE: Partial<Record<StatusType, { bg: string; text: string }>> = {
  major_behind: { bg: "bg-status-major-bg", text: "text-status-major-label" },
  minor_behind:  { bg: "bg-status-minor-bg", text: "text-status-minor-label" },
  patch_behind:  { bg: "bg-status-patch-bg", text: "text-status-patch-label" },
  up_to_date:    { bg: "bg-status-ok-bg",    text: "text-status-ok-label" },
}

export default function ReleaseHeader({
  releaseInfo,
  normalizedScore,
  totalContainers,
  totalWorkloadCount,
  worstStatus,
  issueCount,
  reportId,
}: Props) {
  const backHref = reportId ? `/helm-releases?report=${reportId}` : "/helm-releases"
  const scoreStyle = SEVERITY_STYLE[worstStatus]
  const containers = totalContainers === 1 ? "1 container" : `${totalContainers} containers`
  const workloads = totalWorkloadCount === 1 ? "1 workload" : `${totalWorkloadCount} workloads`

  return (
    <header className="flex items-start justify-between gap-8">
      <div className="flex flex-col gap-2">
        <Button
          asChild
          variant="outline"
          size="icon"
          className="border-gray-200 bg-white hover:bg-gray-50"
          aria-label="Back to Helm Releases"
        >
          <Link href={backHref}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>

        <div className="flex items-center gap-2.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
            {releaseInfo.name}
          </h1>
          <CopyButton value={releaseInfo.name} />
          <span className="rounded-md bg-brand-bg px-2 py-0.5 text-xs font-semibold text-brand-label">
            {releaseInfo.managementKind}
          </span>
          <span
            className={cn(
              "rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums",
              scoreStyle ? [scoreStyle.bg, scoreStyle.text] : "bg-gray-100 text-muted-foreground"
            )}
          >
            {worstStatus === "no_data" || worstStatus === "no_version" ? "—" : normalizedScore.toFixed(2)}
          </span>
          {issueCount > 0 && (
            <span className="flex items-center gap-1 rounded-md bg-status-minor-bg px-1.5 py-0.5 text-status-minor-label">
              <AlertTriangle className="size-3" />
              <span className="text-xs font-medium tabular-nums">{issueCount}</span>
            </span>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          {releaseInfo.namespace} · {containers} · {workloads}
        </p>
      </div>

      <div className="p-1">
        <Refreshbutton />
      </div>
    </header>
  )
}
