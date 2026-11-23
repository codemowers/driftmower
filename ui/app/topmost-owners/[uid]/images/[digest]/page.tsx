"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useParams } from "next/navigation"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import ResourceHeader from "@/app/components/resource-header"
import CopyButton from "@/app/components/copy-button"
import { useImageAnalysis } from "@/lib/features/image-analysis"
import ImageTagStats from "@/app/components/image/image-tag-stats"
import TagIdentity from "@/app/components/image/tag-identity"
import SupportLifecycle from "@/app/components/image/support-lifecycle"
import SourceCard from "@/app/components/image/source-card"
import ImageIssues from "@/app/components/image/image-issues"
import SubpageNav from "@/app/components/layout/subpage-nav"
import VulnerabilitiesCard from "@/app/components/findings/vulnerabilities-card"
import { artifactTitle, containerImageHref, digestCrumb, resolvedVersion } from "@/lib/utils/image-artifacts"
import PageLoading from "@/app/components/page-loading"

export default function ImageTagDetailPage() {
  const params = useParams<{ uid: string; digest: string }>()
  const workloadUid = params.uid
  const digest = decodeURIComponent(params.digest)
  const analysis = useImageAnalysis([digest])
  const data = useClusterState(s => s.data)
  const { linkTo } = useContextHref()

  const workloadMatch = data
    ? Object.entries(data.report.workloadGroupMap).find(
        ([, usages]) => usages[0]?.workloadRootInfo?.uid === workloadUid,
      )
    : undefined

  const usage = workloadMatch?.[1].find(u => u.imageInfo.digest === digest) ?? null

  if (!data) return <PageLoading loading="image" />

  if (!data || !workloadMatch || !usage) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <Page>
          <p className="text-sm text-muted-foreground">Image not found</p>
        </Page>
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

  const rootHref = linkTo("/topmost-owners")
  const workloadHref = linkTo(`/topmost-owners/${workloadUid}`)

  return (
    <div className="min-h-full flex flex-col items-center">
      <Page>
        <ResourceHeader
          icon={ICONS.containerImages}
          iconAriaLabel="OCI image tag"
          title={artifactTitle(repository, version)}
          breadcrumbs={[
            { label: "Workloads", href: rootHref },
            { label: `Namespace ${workloadNamespace}` },
            { label: `${workloadKindLabel} ${workloadName}`, href: workloadHref },
            { label: `Image ${repository}@${digestCrumb(digest)}` },
          ]}
          chips={[{ label: "Image Tag", tone: "brand" }]}
          issueCount={imageIssues.length}
          subtitle={
            <span className="flex items-center gap-1.5">
              <span className="break-all font-mono">{fullRef}</span>
              <CopyButton value={fullRef} />
            </span>
          }
        />
        <SubpageNav items={[
          { label: "Overview", href: linkTo(`/topmost-owners/${encodeURIComponent(workloadUid)}/images/${encodeURIComponent(digest)}`) },
          ...(usage.imageInfo.digest ? [
            { label: "SBOM", href: linkTo(containerImageHref(`${usage.imageInfo.registry}/${usage.imageInfo.repository}`, usage.imageInfo.digest, "sbom")) },
            { label: "Base image", href: linkTo(containerImageHref(`${usage.imageInfo.registry}/${usage.imageInfo.repository}`, usage.imageInfo.digest, "base-image")) },
          ] : []),
        ]} />

        <ImageTagStats usage={usage} analysis={analysis} />


        <div className="grid gap-6 items-start md:grid-cols-[1fr_420px]">
          <TagIdentity usage={usage} />
          <div className="flex flex-col gap-6">
            <ImageIssues issues={imageIssues} />
            <SupportLifecycle usage={usage} />
            <SourceCard usage={usage} />
          </div>
        </div>

        <VulnerabilitiesCard usages={[usage]} limit={10} />
      </Page>
    </div>
  )
}
