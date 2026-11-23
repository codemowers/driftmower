"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { LoaderCircle } from "lucide-react"
import { Suspense, useMemo } from "react"
import PageHeader from "../components/page-header"
import StatusSummaryBar from "../components/status-summary-bar"
import WorkloadList from "./components/workload-list"
import { DRIFT_FOCUS } from "./focus/drift-focus"
import type { WorkloadEntry } from "./focus/types"
import { EMPTY_POD_SUMMARY, summarizePodsByRoot } from "@/lib/utils/pods-by-root"
import { orphanBuckets, reportWorkloadRoots } from "@/lib/utils/report-roots"
import { resourceSummary } from "./components/related-resources"
import SandboxEmptyState from "../components/sandbox-empty-state"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useSandboxScope } from "@/lib/tenancy/sandbox-context"
import { findWorkloadRoot } from "@/lib/cluster/workload-root"
import { SEVERITY_ORDER, STALE_STATUSES } from "@/lib/cluster/styles/status-style"
import { compareIssues, driftIssues } from "@/lib/cluster/issues"
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
  const { sandboxes: scopedSandboxes, namespaces } = useSandboxScope()
  const focus = DRIFT_FOCUS

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
        orphan: root.orphan ? "pod" : undefined,
        issues: [...(root.issues ?? []), ...driftIssues(usages)].sort(compareIssues),
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

  const bucketEntries = orphanBuckets(data).map((bucket): WorkloadEntry => {
    const owners = Object.entries(bucket.orphaned ?? {}).map(([kind, byName]) => {
      const n = Object.keys(byName).length
      return `${n} ${kind.split(".")[0]}${n === 1 ? "" : "s"}`
    })
    return {
      orphan: "bucket",
      orphanSummary: [...owners, resourceSummary(bucket)].filter(Boolean).join(" · "),
      groupKey: `Namespace/${bucket.namespace}/${bucket.name}`,
      uid: bucket.uid,
      kind: "Namespace",
      name: "Orphaned resources",
      namespace: bucket.namespace,
      manager: { kind: "standalone" },
      worstStatus: "no_data",
      repos: [],
      drift: { containerCount: 0, staleRepoCount: 0, distinctRepoCount: 0 },
    }
  })

  const scopeSet = namespaces ? new Set(namespaces) : null
  const scoped = [...reportEntries, ...bucketEntries].filter(w => !scopeSet || scopeSet.has(w.namespace))
  const workloads = scoped
  const rooted = workloads.filter(w => w.orphan !== "bucket")

  return (
    <>
      <Page>
        <PageHeader icon={ICONS.workloads} title="Workloads" subtitle="Controllers at the root of each workload subtree" />
        {(fetching || (!data && !error)) && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />{data ? "Updating workloads…" : "Loading workloads…"}</p>}
        {!data && error && <p role="alert">Could not load workloads: {error}</p>}
        {data && <><StatusSummaryBar
          totalLabel="workloads"
          totalCount={rooted.length}
          secondary={focus.secondary(rooted)}
          pills={focus.pills(rooted)}
        />
        {scopedSandboxes.length > 0 && workloads.length === 0 ? (
          <SandboxEmptyState sandboxes={scopedSandboxes} entity="workloads" />
        ) : (
          <WorkloadList entries={workloads} focus={focus} syncUrl />
        )}
        </>}
      </Page>
    </>
  )
}
