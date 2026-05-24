import { fetchLatestReport, fetchReport } from "./reports"
import { fetchVulnerabilityReports } from "./vulnerability"

// Fetches report + vulnerabilities on load and manual refresh. Not polled.
export async function fetchDynamicData(reportId?: string | null): Promise<void> {
  await Promise.allSettled([
    reportId ? fetchReport(reportId) : fetchLatestReport(),
    fetchVulnerabilityReports(),
  ])
}
