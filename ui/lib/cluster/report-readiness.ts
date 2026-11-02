// "unresolved" is a report whose containers had no comparable version, so its zeros are not health.
export type ReportReadiness = "loading" | "no-reports" | "unresolved" | "ready"

export function reportReadiness({
  hasReport,
  isFetchingReport,
  knownVersions,
  containers,
}: {
  hasReport: boolean
  isFetchingReport: boolean
  knownVersions: number
  containers: number
}): ReportReadiness {
  if (!hasReport) return isFetchingReport ? "loading" : "no-reports"
  if (knownVersions === 0 && containers > 0) return "unresolved"
  return "ready"
}
