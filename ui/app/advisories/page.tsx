"use client"

import PageHeader from "@/app/components/page-header"
import WorkloadAdvisories from "@/app/components/workload-advisories"

// Repository advisories and OSV findings matching deployed source versions,
// across every workload the caller can see.
export default function AdvisoriesPage() {
  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader title="Advisories" subtitle="Source repository advisories affecting deployed versions" />
        <WorkloadAdvisories expanded />
      </main>
    </div>
  )
}
