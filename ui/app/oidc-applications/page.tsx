"use client"

import { useClusterState } from "@/lib/cluster/cluster-state"
import PageHeader from "../components/page-header"

export default function OidcApplicationsPage() {
  const data = useClusterState(s => s.data)

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-10 px-7 py-12">
      <PageHeader title="OIDC Applications" subtitle="Discovered applications" />
      <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>
      </main>
    </div>
  )
}
