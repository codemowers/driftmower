"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import PageHeader from "@/app/components/page-header"
import AdvisoriesCard from "@/app/components/findings/advisories-card"
import { useScopeUsages } from "@/lib/hooks/use-scope"

// Repository advisories and OSV findings matching deployed source versions,
// across every workload the caller can see.
export default function AdvisoriesPage() {
  const usages = useScopeUsages({ kind: "cluster" })
  return (
    <Page>
      <PageHeader icon={ICONS.advisories} title="Advisories" subtitle="Source repository advisories affecting deployed versions" />
      <AdvisoriesCard usages={usages} expanded />
    </Page>
  )
}
