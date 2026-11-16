"use client"

import { Suspense, useMemo } from "react"
import { useParams, useSearchParams } from "next/navigation"
import { Layers } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useSandboxScope } from "@/lib/tenancy/sandbox-context"
import { useContextHref, type LinkTo } from "@/lib/hooks/use-context-href"
import { SEVERITY_STYLE, isNoData } from "@/lib/cluster/styles/status-style"
import { currentChartScopes, deriveImageActions } from "@/lib/features/actions/derive"
import { useActionAssessments } from "@/lib/features/actions/use-action-assessments"
import ResourceHeader from "@/app/components/resource-header"
import ActionsCard from "@/app/components/actions-card"
import CopyButton from "@/app/components/copy-button"
import TagIdentity from "@/app/components/image/tag-identity"
import SourceCard from "@/app/components/image/source-card"
import { SourceAdvisories, SourceReleases } from "@/app/components/image/source-findings"
import ImageInspection from "@/app/components/image/image-inspection"
import BaseImageHierarchy from "@/app/components/image/base-image-hierarchy"
import SupportLifecycle from "@/app/components/image/support-lifecycle"
import ImageIssues from "@/app/components/image/image-issues"
import ImageLicenses from "@/app/components/image/image-licenses"
import ImageVulnerabilities from "@/app/components/image/image-vulnerabilities"
import ImageTagStats from "@/app/components/image/image-tag-stats"
import { artifactTitle, digestCrumb, imagePath, integrityStyle } from "@/lib/utils/image-artifacts"
import ImageStats from "./components/image-stats"
import DeployedByCard from "./components/deployed-by-card"
import TagHistoryCard from "./components/tag-history-card"
import VersionsTable from "./components/versions-table"
import HistoryCard from "./components/history-card"
import { imageDetail, imageUsagesForKey, tagResolution, type ImageDetail, type ImageVersion } from "../utils/image-entries"
import PageLoading from "@/app/components/page-loading"

const PAIR_GRID = "grid gap-6 items-start xl:grid-cols-[1fr_340px]"

export default function ContainerImageDetailPage() {
  return (
    <Suspense>
      <ContainerImageDetailContent />
    </Suspense>
  )
}

function ArtifactView({
  detail,
  version,
  linkTo,
}: {
  detail: ImageDetail
  version: ImageVersion
  linkTo: LinkTo
}) {
  const integrity = integrityStyle(version.tagStatus)
  const crumb = version.digest ? digestCrumb(version.digest) : "no digest"
  const { registry, repository, tag: pinned } = version.usage.imageInfo
  const fullRef = version.digest
    ? `${registry}/${repository}${pinned ? `:${pinned}` : ""}@${version.digest}`
    : `${registry}/${repository}:${pinned}`

  return (
    <>
      <ResourceHeader
        icon={Layers}
        iconAriaLabel="Container image artifact"
        title={artifactTitle(detail.repository, version.resolvedTag)}
        breadcrumbs={[
          { label: "Container Images", href: linkTo("/container-images", { drop: ["focus"] }) },
          { label: `Image ${detail.key}`, href: linkTo(`/container-images/${imagePath(detail.key)}`, { drop: ["focus"] }) },
          { label: crumb },
        ]}
        chips={[
          { label: "Image Tag", tone: "brand" },
          {
            label: version.tagStatus === "mismatch" ? `${integrity.label} · pinned as ${pinned}` : integrity.label,
            className: `${integrity.bg} ${integrity.text}`,
          },
          {
            label: `${version.containerCount} of ${detail.containerCount} containers`,
            tone: "muted",
          },
        ]}
        subtitle={
          <span className="flex items-center gap-1.5">
            <span className="break-all font-mono">{fullRef}</span>
            <CopyButton value={fullRef} />
          </span>
        }
      />

      <ImageTagStats usage={version.usage} />
      <ImageLicenses digests={version.digest ? [version.digest] : []}/>

      <BaseImageHierarchy images={version.usage.imageInfo.platforms ?? []} targetLabel={fullRef} />

      <div className="grid gap-6 items-start md:grid-cols-[1fr_320px]">
        <TagIdentity usage={version.usage} />
        <div className="flex flex-col gap-6">
          <SourceCard usage={version.usage} />
          <SupportLifecycle usage={version.usage} />
        </div>
      </div>

      <SourceAdvisories key={`advisories-${version.artifactKey}`} usage={version.usage} />
      <ImageVulnerabilities key={`cves-${version.artifactKey}`} usage={version.usage} />
      <SourceReleases key={`releases-${version.artifactKey}`} usage={version.usage} />
      <ImageInspection usage={version.usage} />
    </>
  )
}

function ContainerImageDetailContent() {
  const params = useParams<{ image: string[] }>()
  const key = (params.image ?? []).map(decodeURIComponent).join("/")
  const searchParams = useSearchParams()
  const data = useClusterState(s => s.data)
  const clusterResources = useClusterState(s => s.clusterResources)
  const vulnerabilityReports = useClusterState(s => s.vulnerabilityReports)
  const { namespaces } = useSandboxScope()
  const { linkTo } = useContextHref()

  const scope = useMemo(() => (namespaces ? new Set(namespaces) : null), [namespaces])
  const usages = useMemo(() => imageUsagesForKey(data, key, scope), [data, key, scope])
  const actionRows = useMemo(() => deriveImageActions(usages, clusterResources, vulnerabilityReports), [usages, clusterResources, vulnerabilityReports])
  const currentCharts = useMemo(() => currentChartScopes(usages), [usages])
  const assessments = useActionAssessments(actionRows, currentCharts)

  const detail = imageDetail(data, key, scope)

  if (!data) return <PageLoading loading="image" />

  if (!data || !detail) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <p className="text-sm text-muted-foreground">Image not found in the current inventory</p>
        </main>
      </div>
    )
  }

  const selectedKey = searchParams.get("artifact")
  const selected = selectedKey
    ? detail.versions.find(v => v.artifactKey === selectedKey)
    : undefined

  if (selected) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <ArtifactView detail={detail} version={selected} linkTo={linkTo} />
        </main>
      </div>
    )
  }

  const tags = tagResolution(data, detail.key)
  const driftStyle = SEVERITY_STYLE[detail.worstStatus]
  const repositoryUrl = detail.versions[0]?.usage.imageInfo.repositoryUrl
  const failureReason = detail.issues[0]
    ? `${detail.issues[0].type}: ${detail.issues[0].message}`
    : detail.versions.some(v => v.tagStatus === "digest_verification_failed")
      ? "The running digest matches no published tag."
      : null

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <ResourceHeader
          icon={Layers}
          iconAriaLabel="Container image"
          title={detail.repository}
          copyValue={detail.key}
          breadcrumbs={[
            { label: "Container Images", href: linkTo("/container-images", { drop: ["focus"] }) },
            { label: `Image ${detail.key}` },
          ]}
          chips={[{ label: "Image", tone: "brand" }]}
          scoreChip={
            !isNoData(detail.worstStatus) && driftStyle
              ? { status: detail.worstStatus, score: 0, label: driftStyle.label }
              : null
          }
          issueCount={detail.issueCount}
          subtitle={
            <span className="flex items-center gap-1.5">
              <span className="font-mono">{detail.registry}</span>
              {repositoryUrl && (
                <>
                  <span>·</span>
                  <a
                    href={repositoryUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono hover:text-brand-text hover:underline"
                  >
                    {repositoryUrl.replace(/^https?:\/\//, "")}
                  </a>
                </>
              )}
            </span>
          }
        />

        <ImageStats detail={detail} />
        <ImageLicenses digests={detail.digests}/>

        <BaseImageHierarchy images={detail.versions.flatMap(version => version.usage.imageInfo.platforms ?? [])} targetLabel={detail.key} />

        <ActionsCard {...assessments} />

        {detail.issues.length > 0 && <ImageIssues issues={detail.issues} />}

        <div className={PAIR_GRID}>
          <div className="flex min-w-0 flex-col gap-6">
            <DeployedByCard
              rows={detail.workloadRows}
              containerCount={detail.containerCount}
              namespaceCount={detail.namespaceCount}
              showVersions={detail.versions.length > 1}
              linkTo={linkTo}
            />
            <VersionsTable versions={detail.versions} containerCount={detail.containerCount} />
            <HistoryCard imageKey={detail.key} />
          </div>
          <div className="flex flex-col gap-6">
            {detail.versions[0] && (
              <>
                <SourceCard usage={detail.versions[0].usage} showRevision={false} />
                <SupportLifecycle usage={detail.versions[0].usage} />
              </>
            )}
          </div>
        </div>

        {tags && (
          <TagHistoryCard
            considered={tags.considered}
            offChannel={tags.offChannel}
            availableCount={tags.availableCount}
            deployedTags={detail.runningTags}
            latest={tags.latest ?? detail.latestTag}
            scrape={tags.scrape}
            failureReason={failureReason}
          />
        )}
      </main>
    </div>
  )
}
