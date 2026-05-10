import Link from "next/link"
import { ArrowLeft, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import Refreshbutton from "@/app/components/core/refresh-button"
import CopyButton from "@/app/components/copy-button"
import { cn } from "@/lib/utils"
import type { StatusType } from "@/lib/cluster/reports"

type Props = {
  kind: string
  name: string
  namespace: string
  manager: { kind: "helm" | "standalone" }
  totalContainers: number
  totalPods: number
  worstStatus: StatusType
  normalizedScore: number
  issueCount: number
  reportId: string | null
}

const SEVERITY_STYLE: Partial<Record<StatusType, { bg: string; text: string }>> = {
  major_behind: { bg: "bg-status-major-bg", text: "text-status-major-label" },
  minor_behind:  { bg: "bg-status-minor-bg", text: "text-status-minor-label" },
  patch_behind:  { bg: "bg-status-patch-bg", text: "text-status-patch-label" },
  up_to_date:    { bg: "bg-status-ok-bg",    text: "text-status-ok-label" },
}

export default function WorkloadHeader({
  kind,
  name,
  namespace,
  manager,
  totalContainers,
  totalPods,
  worstStatus,
  normalizedScore,
  issueCount,
  reportId,
}: Props) {
  const backHref = reportId ? `/topmost-owners?report=${reportId}` : "/topmost-owners"
  const scoreStyle = SEVERITY_STYLE[worstStatus]
  const containers = totalContainers === 1 ? "1 container" : `${totalContainers} containers`
  const pods = totalPods === 1 ? "1 pod" : `${totalPods} pods`

  return (
    <header className="flex items-start justify-between gap-8">
      <div className="flex flex-col gap-2">
        <Button
          asChild
          variant="outline"
          size="icon"
          className="border-gray-200 bg-white hover:bg-gray-50"
          aria-label="Back to Topmost Owners"
        >
          <Link href={backHref}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>

        <div className="flex items-center gap-2.5">
          <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
            {name}
          </h1>
          <CopyButton value={name} />
          <span className="rounded-md bg-brand-bg px-2 py-0.5 text-xs font-semibold text-brand-label">
            {kind}
          </span>
          <span
            className={cn(
              "rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums",
              scoreStyle ? [scoreStyle.bg, scoreStyle.text] : "bg-gray-100 text-muted-foreground"
            )}
          >
            {worstStatus === "no_data" || worstStatus === "no_version" ? "—" : normalizedScore.toFixed(2)}
          </span>
          {manager.kind === "standalone" && (
            <span className="rounded-md bg-gray-100 px-2 py-0.5 text-xs font-semibold text-muted-foreground">
              standalone
            </span>
          )}
          {issueCount > 0 && (
            <span className="flex items-center gap-1 rounded-md bg-status-minor-bg px-1.5 py-0.5 text-status-minor-label">
              <AlertTriangle className="size-3" />
              <span className="text-xs font-medium tabular-nums">{issueCount}</span>
            </span>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          {namespace} · {containers} · {pods}
        </p>
      </div>

      <div className="p-1">
        <Refreshbutton />
      </div>
    </header>
  )
}
