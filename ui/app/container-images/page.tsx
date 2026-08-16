"use client"

import { Suspense } from "react"
import PageHeader from "../components/page-header"
import StatusSummaryBar from "../components/status-summary-bar"
import TenantEmptyState from "../components/tenant-empty-state"
import ImageList from "./components/image-list"
import { imageEntries } from "./utils/image-entries"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useTenantScope } from "@/lib/tenancy/tenant-context"
import { DISPLAY_ORDER, DRIFT_PILL_STATUSES, driftSummaryPills, isNoData } from "@/lib/cluster/status-style"
import type { StatusType } from "@/lib/cluster/reports"

export default function ContainerImagesPage() {
  const { data } = useClusterState()
  const { tenants: scopedTenants, namespaces } = useTenantScope()

  const entries = imageEntries(data, namespaces ? new Set(namespaces) : null)
    .sort((a, b) =>
      DISPLAY_ORDER[a.worstStatus] - DISPLAY_ORDER[b.worstStatus] ||
      b.containerCount - a.containerCount ||
      a.repository.localeCompare(b.repository),
    )

  const totalContainers = entries.reduce((sum, e) => sum + e.containerCount, 0)
  const statusCounts = Object.fromEntries(
    DRIFT_PILL_STATUSES.map(status => [status, entries.filter(e => e.worstStatus === status).length]),
  ) as Partial<Record<StatusType, number>>
  const noDataCount = entries.filter(e => isNoData(e.worstStatus)).length

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader title="Container Images" subtitle="Every unique image running in the cluster" />
        <StatusSummaryBar
          totalLabel="images"
          totalCount={entries.length}
          secondary={{ label: "containers", count: totalContainers }}
          pills={driftSummaryPills(statusCounts, noDataCount)}
        />
        {scopedTenants.length > 0 && entries.length === 0 ? (
          <TenantEmptyState tenants={scopedTenants} entity="images" />
        ) : (
          <Suspense>
            <ImageList entries={entries} />
          </Suspense>
        )}
      </main>
    </div>
  )
}
