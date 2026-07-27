"use client"

import { Suspense, startTransition, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import PageHeader from "../components/page-header"
import StatusSummaryBar from "../components/status-summary-bar"
import WorkloadList from "./components/workload-list"
import FocusSelect from "./components/focus-select"
import { DEFAULT_FOCUS, FOCUSES, FOCUS_STORAGE_KEY, resolveFocusKey } from "./focus"
import type { FocusKey, WorkloadEntry } from "./focus/types"
import { EMPTY_POD_SUMMARY, summarizePodsByRoot } from "./utils/pod-summary"
import { liveWorkloadEntries } from "./utils/live-entries"
import { reportWorkloadRoots } from "./utils/report-roots"
import TenantEmptyState from "../components/tenant-empty-state"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useTenantScope } from "@/lib/tenancy/tenant-context"
import { findWorkloadRoot } from "@/lib/cluster/workload-root"
import { parseFilterTokens } from "@/lib/utils/filter-params"
import { SEVERITY_ORDER, STALE_STATUSES } from "@/lib/cluster/status-style"
import type { StatusType } from "@/lib/cluster/reports"

export default function TopmostOwnersPage() {
  return (
    <Suspense>
      <TopmostOwnersContent />
    </Suspense>
  )
}

function TopmostOwnersContent() {
  const data = useClusterState(s => s.data)
  const clusterResources = useClusterState(s => s.clusterResources)
  const isLoading = useClusterState(s => s.isLoading)
  const isFetchingReport = useClusterState(s => s.isFetchingReport)
  const router = useRouter()
  const searchParams = useSearchParams()
  const { tenant, namespaces } = useTenantScope()

  const [storedFocus, setStoredFocus] = useState<string | null>(null)
  useEffect(() => {
    const stored = localStorage.getItem(FOCUS_STORAGE_KEY)
    if (stored) startTransition(() => setStoredFocus(stored))
  }, [])

  const focusKey = resolveFocusKey(searchParams.get("focus"), storedFocus)
  const focus = FOCUSES[focusKey]

  function handleFocusChange(key: FocusKey) {
    if (key === focusKey) return
    localStorage.setItem(FOCUS_STORAGE_KEY, key)
    setStoredFocus(key)

    const params = new URLSearchParams(searchParams.toString())
    if (key === DEFAULT_FOCUS) params.delete("focus")
    else params.set("focus", key)

    const previousTokens = new Set(focus.scale.map(l => l.token))
    const keptFilters = [...parseFilterTokens(params.get("filters"))].filter(t => !previousTokens.has(t))
    if (keptFilters.length) params.set("filters", keptFilters.join(","))
    else params.delete("filters")

    const next = params.toString()
    router.replace(next ? `?${next}` : window.location.pathname)
  }

  const podSummaries = useMemo(() => summarizePodsByRoot(clusterResources), [clusterResources])

  const releaseUidByGroupKey = new Map<string, string>()
  if (data) {
    for (const score of Object.values(data.rotenness.releaseScores)) {
      releaseUidByGroupKey.set(score.releaseInfo.groupKey, score.releaseInfo.uid)
    }
  }

  const resolvedLiveUids = new Set<string>()

  const reportEntries: WorkloadEntry[] = reportWorkloadRoots(data)
    .map(({ groupKey, kind, namespace, name, uid, usages }): WorkloadEntry => {
          const ri = usages[0]?.releaseInfo
          const releaseUid = ri ? releaseUidByGroupKey.get(ri.groupKey) : undefined
          const liveRoot = usages[0]?.workloadRootInfo
            ? findWorkloadRoot(clusterResources, usages[0].workloadRootInfo)
            : undefined
          if (liveRoot) resolvedLiveUids.add(liveRoot.uid)
          const argoApp = liveRoot?.argoApp
          const manager: WorkloadEntry["manager"] =
            ri?.managementKind === "helm" && releaseUid
              ? { kind: "helm", name: ri.name, uid: releaseUid }
              : argoApp
                ? { kind: "argo", name: argoApp.name, url: argoApp.url }
                : { kind: "standalone" }

          const repoStatus = new Map<string, StatusType>()
          for (const u of usages) {
            const repo = `${u.imageInfo.registry}/${u.imageInfo.repository}`
            const prev = repoStatus.get(repo)
            const cur = u.versionStatus.statusType
            if (prev === undefined || SEVERITY_ORDER[cur] > SEVERITY_ORDER[prev]) {
              repoStatus.set(repo, cur)
            }
          }
          const distinctRepoCount = repoStatus.size
          const staleRepoCount = Array.from(repoStatus.values()).filter(s => STALE_STATUSES.includes(s)).length

          const worstStatus = usages.reduce<StatusType>((worst, u) => {
            const s = u.versionStatus.statusType
            return SEVERITY_ORDER[s] > SEVERITY_ORDER[worst] ? s : worst
          }, "no_data")

          const issueCount = (data?.issues ?? []).filter(i =>
            usages.some(u => u.image.includes(i.image))
          ).length

          const pods = liveRoot
            ? podSummaries.get(liveRoot.uid) ?? EMPTY_POD_SUMMARY
            : undefined

          return {
            groupKey,
            uid,
            kind,
            name,
            namespace,
            manager,
            worstStatus,
            issueCount,
            inReport: true,
            repos: [...repoStatus.keys()],
            drift: {
              containerCount: usages.length,
              staleRepoCount,
              distinctRepoCount,
            },
            pods,
          }
        })

  const reportSettled = data !== null || (!isLoading && !isFetchingReport)
  const excludeUids = new Set(resolvedLiveUids)
  const excludeGroupKeys = new Set<string>()
  for (const entry of reportEntries) {
    excludeUids.add(entry.uid)
    excludeGroupKeys.add(entry.groupKey)
  }
  const liveEntries = reportSettled
    ? liveWorkloadEntries(clusterResources, podSummaries, excludeUids, excludeGroupKeys)
    : []

  const scopeSet = namespaces ? new Set(namespaces) : null
  const workloads = [...reportEntries, ...liveEntries]
    .filter(w => !scopeSet || scopeSet.has(w.namespace))

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader title="Topmost Owners" subtitle="Controllers at the root of each workload subtree" />
        <StatusSummaryBar
          totalLabel="workloads"
          totalCount={workloads.length}
          secondary={focus.secondary(workloads)}
          pills={focus.pills(workloads)}
          leading={<FocusSelect focus={focus} onChange={handleFocusChange} />}
        />
        {tenant && workloads.length === 0 ? (
          <TenantEmptyState tenant={tenant} entity="workloads" />
        ) : (
          <WorkloadList entries={workloads} focus={focus} />
        )}
      </main>
    </div>
  )
}
