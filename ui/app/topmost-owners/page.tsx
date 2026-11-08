"use client"

import { LoaderCircle } from "lucide-react"
import { Suspense, startTransition, useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import PageHeader from "../components/page-header"
import StatusSummaryBar from "../components/status-summary-bar"
import WorkloadList from "./components/workload-list"
import FocusSelect from "./components/focus-select"
import { DEFAULT_FOCUS, FOCUSES, FOCUS_STORAGE_KEY, resolveFocusKey } from "./focus"
import type { FocusKey, WorkloadEntry } from "./focus/types"
import { EMPTY_POD_SUMMARY, summarizePodsByRoot } from "@/lib/utils/pods-by-root"
import { useWorkloadHistory } from "@/lib/features/drift-history/use-bulk-drift-history"
import { reportWorkloadRoots } from "@/lib/utils/report-roots"
import SandboxEmptyState from "../components/sandbox-empty-state"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useSandboxScope } from "@/lib/tenancy/sandbox-context"
import { findWorkloadRoot } from "@/lib/cluster/workload-root"
import { parseFilterTokens } from "@/lib/utils/filter-params"
import { SEVERITY_ORDER, STALE_STATUSES } from "@/lib/cluster/styles/status-style"
import type { StatusType } from "@/lib/cluster/reports"

export default function TopmostOwnersPage() {
  return (
    <Suspense>
      <TopmostOwnersContent />
    </Suspense>
  )
}

function TopmostOwnersContent() {
  const fetching = useClusterState(s => s.isFetchingReport)
  const error = useClusterState(s => s.error)
  const data = useClusterState(s => s.data)
  const clusterResources = useClusterState(s => s.clusterResources)
  const searchParams = useSearchParams()
  const { sandboxes: scopedSandboxes, namespaces } = useSandboxScope()

  const [storedFocus, setStoredFocus] = useState<string | null>(null)
  const [focusResolved, setFocusResolved] = useState(false)
  useEffect(() => {
    const stored = localStorage.getItem(FOCUS_STORAGE_KEY)
    startTransition(() => {
      if (stored) setStoredFocus(stored)
      setFocusResolved(true)
    })
  }, [])

  const focusKey = resolveFocusKey(searchParams.get("focus"), storedFocus)
  const focus = FOCUSES[focusKey]
  const history = useWorkloadHistory(focusKey === "history")

  useEffect(() => {
    if (!focusResolved || focusKey === DEFAULT_FOCUS || searchParams.get("focus")) return
    const params = new URLSearchParams(searchParams.toString())
    params.set("focus", focusKey)
    window.history.replaceState(null, "", `?${params.toString()}`)
  }, [focusResolved, focusKey, searchParams])

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
    window.history.replaceState(null, "", next ? `?${next}` : window.location.pathname)
  }

  const podSummaries = useMemo(() => summarizePodsByRoot(clusterResources), [clusterResources])

  const releaseUidByGroupKey = new Map<string, string>()
  if (data) {
    for (const score of Object.values(data.rotenness.releaseScores)) {
      releaseUidByGroupKey.set(score.releaseInfo.groupKey, score.releaseInfo.uid)
    }
  }

  const reportEntries: WorkloadEntry[] = reportWorkloadRoots(data)
    .map((root): WorkloadEntry => {
      const { groupKey, kind, namespace, name, uid, usages } = root
      const ri = usages[0]?.releaseInfo
      const releaseUid = ri ? releaseUidByGroupKey.get(ri.groupKey) : undefined
      const liveRoot = findWorkloadRoot(clusterResources, root)
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

      return {
        sourceState: usages.some(u => u.imageInfo.sourceStatus === "linked") ? "linked" : usages.length > 0 && usages.every(u => u.imageInfo.sourceStatus === "unlinked") ? "unlinked" : "unknown",
        desiredReplicas: root.desiredReplicas,
        completed: root.completed,
        groupKey,
        uid,
        kind,
        name,
        namespace,
        manager,
        worstStatus,
        repos: [...repoStatus.keys()],
        drift: {
          containerCount: usages.length,
          staleRepoCount,
          distinctRepoCount,
        },
        pods: liveRoot ? podSummaries.get(liveRoot.uid) ?? EMPTY_POD_SUMMARY : undefined,
      }
    })

  const scopeSet = namespaces ? new Set(namespaces) : null
  const scoped = reportEntries.filter(w => !scopeSet || scopeSet.has(w.namespace))
  const workloads = focus.key === "history"
    ? scoped.map(w => ({ ...w, history: history[w.groupKey] }))
    : scoped

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader title="Topmost Owners" subtitle="Controllers at the root of each workload subtree" />
        {(fetching || (!data && !error)) && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{data ? "Updating workloads…" : "Loading workloads…"}</p>}
        {!data && error && <p role="alert">Could not load workloads: {error}</p>}
        {data && <><StatusSummaryBar
          totalLabel="workloads"
          totalCount={workloads.length}
          secondary={focus.secondary(workloads)}
          pills={focus.pills(workloads)}
          leading={<FocusSelect focus={focus} onChange={handleFocusChange} />}
        />
        {scopedSandboxes.length > 0 && workloads.length === 0 ? (
          <SandboxEmptyState sandboxes={scopedSandboxes} entity="workloads" />
        ) : (
          <WorkloadList key={focus.key} entries={workloads} focus={focus} syncUrl={focusResolved} />
        )}
        </>}
      </main>
    </div>
  )
}
