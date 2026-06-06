"use client"

import { useParams } from "next/navigation"
import { Bookmark } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { findWorkloadRoot } from "@/lib/cluster/workload-root"
import { workloadKindLabel, type StatusType } from "@/lib/cluster/reports"
import ResourceHeader from "@/app/components/resource-header"
import ImageTagStats from "./components/image-tag-stats"
import TagIdentity from "./components/tag-identity"
import SupportLifecycle from "./components/support-lifecycle"
import ImageIssues from "./components/image-issues"
import ImageVulnerabilities from "./components/image-vulnerabilities"

const STATUS_LABEL: Record<StatusType, string> = {
  major_behind: "Major",
  minor_behind: "Minor",
  patch_behind: "Patch",
  up_to_date:   "OK",
  ahead:        "Ahead",
  no_data:      "No data",
  no_version:   "No version",
}

function statusLabel(status: string): string {
  return STATUS_LABEL[status as StatusType] ?? status.replace(/_/g, " ")
}

export default function ImageTagDetailPage() {
  const params = useParams<{ uid: string; digest: string }>()
  const workloadUid = params.uid
  const digest = decodeURIComponent(params.digest)
  const data = useClusterState(s => s.data)
  const reportId = useClusterState(s => s.reportId)
  const clusterResources = useClusterState(s => s.clusterResources)

  const workloadMatch = data
    ? Object.entries(data.report.workloadGroupMap).find(
        ([, usages]) => usages[0]?.workloadRootInfo?.uid === workloadUid,
      )
    : undefined

  const usage = workloadMatch?.[1].find(u => u.imageInfo.digest === digest) ?? null

  if (!data || !workloadMatch || !usage) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <p className="text-sm text-muted-foreground">Image not found</p>
        </main>
      </div>
    )
  }

  const workloadRoot = workloadMatch[1][0]?.workloadRootInfo
  const workloadName = workloadRoot?.name ?? "—"
  const workloadKind = workloadRoot?.kind ?? "—"
  const workloadNamespace = workloadRoot?.namespace ?? "—"
  const apiGroup = workloadRoot ? findWorkloadRoot(clusterResources, workloadRoot)?.apiGroup : undefined
  const { registry, repository, tag } = usage.imageInfo
  const repoLabel = `${registry}/${repository}`
  const fullRef = `${repoLabel}:${tag}@${digest}`

  const imageIssues = data.issues.filter(i => usage.image.includes(i.image))
  const status = usage.versionStatus.statusType

  const rootHref = reportId ? `/topmost-owners?report=${reportId}` : "/topmost-owners"
  const workloadHref = reportId
    ? `/topmost-owners/${workloadUid}?report=${reportId}`
    : `/topmost-owners/${workloadUid}`

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <ResourceHeader
          icon={Bookmark}
          iconAriaLabel="OCI image tag"
          title={repoLabel}
          copyValue={fullRef}
          breadcrumbs={[
            { label: "Workloads", href: rootHref },
            { label: `Namespace ${workloadNamespace}` },
            { label: `${workloadKindLabel(workloadKind, apiGroup)} ${workloadName}`, href: workloadHref },
            { label: `Image ${repoLabel}` },
          ]}
          chips={[{ label: "Image Tag", tone: "brand" }]}
          scoreChip={{ status, score: 0, label: statusLabel(status) }}
          issueCount={imageIssues.length}
          subtitle={digest}
        />

        <ImageTagStats usage={usage} />

        <TagIdentity usage={usage} />

        {imageIssues.length > 0 ? (
          <div className="grid gap-6 items-start md:grid-cols-[1.4fr_1fr]">
            <ImageIssues issues={imageIssues} />
            <SupportLifecycle usage={usage} />
          </div>
        ) : (
          <SupportLifecycle usage={usage} />
        )}

        <ImageVulnerabilities usage={usage} />
      </main>
    </div>
  )
}
