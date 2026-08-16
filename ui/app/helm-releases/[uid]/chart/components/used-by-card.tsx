import Link from "next/link"
import { ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import type { ReleaseScore } from "@/lib/cluster/reports"

export function chartIdentity(info: ReleaseScore["releaseInfo"]): string {
  return `${info.chartName}|${info.chartSource ?? ""}|${info.chartRepoUrl ?? ""}`
}

type Props = {
  releases: ReleaseScore[]
  linkTo: (path: string, options?: { drop?: string[] }) => string
}

export default function UsedByCard({ releases, linkTo }: Props) {
  if (releases.length < 2) return null

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Used By
      </p>
      <div className="rounded-xl border border-gray-200 bg-white">
        {releases.map((score, i) => (
          <Link
            key={score.groupKey}
            href={linkTo(`/helm-releases/${score.releaseInfo.uid}`, { drop: ["htab", "focus"] })}
            className={cn(
              "flex items-center gap-2 px-4 py-3 transition-colors hover:bg-brand-bg/30",
              i > 0 && "border-t border-gray-100",
            )}
          >
            <span className="min-w-0 truncate font-mono text-[13px] text-foreground">
              {score.releaseInfo.name}
            </span>
            <span className="shrink-0 rounded-md bg-brand-bg px-1.5 py-0.5 text-[10px] font-semibold text-brand-label">
              helm
            </span>
            <span className="ml-auto shrink-0 whitespace-nowrap font-mono text-[11px] text-muted-foreground">
              {score.releaseInfo.namespace}
              {score.releaseInfo.revision !== undefined && <> · rev {score.releaseInfo.revision}</>}
            </span>
            <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </div>
  )
}
