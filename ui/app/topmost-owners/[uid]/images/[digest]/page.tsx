"use client"

import { useParams } from "next/navigation"
import { Layers } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import type { StatusType } from "@/lib/cluster/reports"
import { useContextHref } from "@/lib/hooks/use-context-href"
import ResourceHeader from "@/app/components/resource-header"
import CopyButton from "@/app/components/copy-button"
import ImageTagStats from "@/app/components/image/image-tag-stats"
import TagIdentity from "@/app/components/image/tag-identity"
import SupportLifecycle from "@/app/components/image/support-lifecycle"
import SourceCard from "@/app/components/image/source-card"
import ImageIssues from "@/app/components/image/image-issues"
import ImageVulnerabilities from "@/app/components/image/image-vulnerabilities"
import { artifactTitle, digestCrumb, resolvedVersion } from "@/lib/utils/image-artifacts"

const STATUS_LABEL: Record<StatusType, string> = {
  major_behind: "Major",
  minor_behind: "Minor",
  patch_behind: "Patch",
  up_to_date:   "OK",
  ahead:        "Ahead",
  behind:       "Behind",
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
  const { linkTo } = useContextHref()

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
  const workloadKindLabel = workloadRoot?.qualifiedKind ?? workloadKind
  const { registry, repository, tag } = usage.imageInfo
  const repoLabel = `${registry}/${repository}`
  const fullRef = `${repoLabel}:${tag}@${digest}`
  const version = resolvedVersion(usage)

  const imageIssues = data.issues.filter(i => usage.image.includes(i.image))
  const status = usage.versionStatus.statusType

  const rootHref = linkTo("/topmost-owners")
  const workloadHref = linkTo(`/topmost-owners/${workloadUid}`)

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <ResourceHeader
          icon={Layers}
          iconAriaLabel="OCI image tag"
          title={artifactTitle(repository, version)}
          breadcrumbs={[
            { label: "Workloads", href: rootHref },
            { label: `Namespace ${workloadNamespace}` },
            { label: `${workloadKindLabel} ${workloadName}`, href: workloadHref },
            { label: `Image ${repository}@${digestCrumb(digest)}` },
          ]}
          chips={[{ label: "Image Tag", tone: "brand" }]}
          scoreChip={{ status, score: 0, label: statusLabel(status) }}
          issueCount={imageIssues.length}
          subtitle={
            <span className="flex items-center gap-1.5">
              <span className="break-all font-mono">{fullRef}</span>
              <CopyButton value={fullRef} />
            </span>
          }
        />

        <ImageTagStats usage={usage} />

        <div className="grid gap-6 items-start md:grid-cols-[1fr_420px]">
          <TagIdentity usage={usage} />
          <div className="flex flex-col gap-6">
            <ImageIssues issues={imageIssues} />
            <SupportLifecycle usage={usage} />
            <SourceCard usage={usage} />
          </div>
        </div>

        <ImageVulnerabilities usage={usage} />
      </main>
    </div>
  )
}
