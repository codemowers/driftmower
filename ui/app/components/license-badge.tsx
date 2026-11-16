import { classifyLicense } from "@/lib/features/crawler/license"
import { licenseLabel, type RepositoryLicense } from "@/lib/features/crawler/sources"

export default function LicenseBadge({ license }: { license?: RepositoryLicense }) {
  const info = classifyLicense(license)
  const colors = info.tone === "green" ? "bg-status-ok-bg text-status-ok-label" : info.tone === "yellow" ? "bg-status-minor-bg text-status-minor-label" : "bg-muted text-muted-foreground"
  return <span title={`${info.title} · ${info.classification}${info.osi && info.classification !== "OSI approved" ? " · OSI approved" : ""}`} className={`inline-flex rounded-md px-2 py-1 text-xs font-medium ${colors}`}>{licenseLabel(license)}</span>
}
