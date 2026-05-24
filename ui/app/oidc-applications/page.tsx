"use client"

import { useClusterState } from "@/lib/cluster/cluster-state"
import PageHeader from "../components/page-header"

export default function OidcApplicationsPage() {
  const data = useClusterState(s => s.data)
  const vulnerabilityReports = useClusterState(s => s.vulnerabilityReports)

  const digests = vulnerabilityReports ? Object.keys(vulnerabilityReports) : []
  const firstReport = digests.length > 0 ? vulnerabilityReports![digests[0]] : null

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-10 px-7 py-12">
      <PageHeader title="OIDC Applications" subtitle="Discovered applications" />
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Vulnerability report (1 of {digests.length} digests)</h2>
        <pre className="text-xs">{JSON.stringify(firstReport, null, 2)}</pre>
      </section>
      <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>
      </main>
    </div>
  )
}
