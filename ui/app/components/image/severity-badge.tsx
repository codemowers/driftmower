import { cn } from "@/lib/utils/cn"
import { CVE_SEVERITY_STYLE, type VulnerabilitySeverity } from "@/lib/features/vulnerability"

export default function SeverityBadge({ severity, score }: { severity: VulnerabilitySeverity; score?: number }) {
  const s = CVE_SEVERITY_STYLE[severity]
  const hasScore = score !== undefined && Number.isFinite(score) && score > 0
  return (
    <span className={cn("rounded text-xs font-semibold whitespace-nowrap", hasScore ? "inline-flex flex-col items-center gap-0.5 px-2.5 py-2" : "px-1.5 py-0.5", s.bg, s.text)}>
      {hasScore && <span aria-label={`CVSS ${score.toFixed(1)}`} className="text-2xl font-bold leading-none tabular-nums">{score.toFixed(1)}</span>}
      <span>{s.label}</span>
    </span>
  )
}
