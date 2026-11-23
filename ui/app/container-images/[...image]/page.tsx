"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import PrefetchLink from "@/app/components/prefetch-link"
import { sourceRepositoryPath } from "@/lib/features/crawler/sources"
import { Suspense, useMemo } from "react"
import { useParams } from "next/navigation"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useSandboxScope } from "@/lib/tenancy/sandbox-context"
import { useContextHref, type LinkTo } from "@/lib/hooks/use-context-href"
import { SEVERITY_STYLE, isNoData } from "@/lib/cluster/styles/status-style"
import ResourceHeader from "@/app/components/resource-header"
import CopyButton from "@/app/components/copy-button"
import TagIdentity from "@/app/components/image/tag-identity"
import SourceCard from "@/app/components/image/source-card"
import { SourceAdvisories, SourceReleases } from "@/app/components/image/source-findings"
import ImageInspection from "@/app/components/image/image-inspection"
import BaseImageHierarchy from "@/app/components/image/base-image-hierarchy"
import SupportLifecycle from "@/app/components/image/support-lifecycle"
import IssuesCard from "@/app/components/findings/issues-card"
import { driftIssues } from "@/lib/cluster/issues"
import { useImageAnalysis } from "@/lib/features/image-analysis"
import ImageAnalysisCard from "@/app/components/image/image-analysis"
import ImageSbom from "@/app/components/image/image-sbom"
import { ArtifactNav } from "@/app/components/layout/resource-navs"
import VulnerabilitiesCard from "@/app/components/findings/vulnerabilities-card"
import ImageTagStats from "@/app/components/image/image-tag-stats"
import { artifactTitle, containerImageHref, digestCrumb, integrityStyle, parseContainerImagePath } from "@/lib/utils/image-artifacts"
import ImageStats from "./components/image-stats"
import DeployedByCard from "./components/deployed-by-card"
import TagHistoryCard from "./components/tag-history-card"
import VersionsTable from "./components/versions-table"
import { imageDetail, tagResolution, type ImageDetail, type ImageVersion } from "../utils/image-entries"
import PageLoading from "@/app/components/page-loading"

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
  const analysis = useImageAnalysis([version.digest ?? ""], true)
  const integrity = integrityStyle(version.tagStatus)
  const crumb = version.digest ? digestCrumb(version.digest) : "no digest"
  const { registry, repository, tag: pinned } = version.usage.imageInfo
  const fullRef = version.digest
    ? `${registry}/${repository}${pinned ? `:${pinned}` : ""}@${version.digest}`
    : `${registry}/${repository}:${pinned}`

  return (
    <>
      <ResourceHeader
        icon={ICONS.containerImages}
        iconAriaLabel="Container image artifact"
        title={artifactTitle(detail.repository, version.resolvedTag)}
        breadcrumbs={[
          { label: "Container Images", href: linkTo("/container-images", { drop: ["focus"] }) },
          { label: `Image ${detail.key}`, href: linkTo(containerImageHref(detail.key), { drop: ["focus"] }) },
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

      <ArtifactNav image={detail.key} artifact={version.artifactKey} />
      <ImageTagStats usage={version.usage} analysis={analysis} />
      <IssuesCard resourceIssues={driftIssues([version.usage])} />


      <div className="grid gap-6 items-start md:grid-cols-[1fr_320px]">
        <TagIdentity usage={version.usage} />
        <div className="flex flex-col gap-6">
          <SourceCard usage={version.usage} />
          <SupportLifecycle usage={version.usage} />
        </div>
      </div>

      <SourceAdvisories key={`advisories-${version.artifactKey}`} usage={version.usage} />
      <VulnerabilitiesCard key={`cves-${version.artifactKey}`} usages={[version.usage]} limit={10} />
      <SourceReleases key={`releases-${version.artifactKey}`} usage={version.usage} />
      {version.digest && <ImageAnalysisCard digest={version.digest} result={analysis} />}
      <ImageInspection usage={version.usage} />
    </>
  )
}

function ContainerImageDetailContent() {
  const params = useParams<{ image: string[] }>()
  const { key, artifact: selectedKey, subpage } = parseContainerImagePath(params.image ?? [])
  const data = useClusterState(s => s.data)
  const { namespaces } = useSandboxScope()
  const { linkTo } = useContextHref()

  const scope = useMemo(() => (namespaces ? new Set(namespaces) : null), [namespaces])

  const detail = imageDetail(data, key, scope)

  if (!data) return <PageLoading loading="image" />

  if (!data || !detail) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <Page>
          <p className="text-sm text-muted-foreground">Image not found in the current inventory</p>
        </Page>
      </div>
    )
  }

  const selected = selectedKey
    ? detail.versions.find(v => v.artifactKey === selectedKey)
    : undefined

  // Artifact subpages share the artifact's header and navigation.
  const ARTIFACT_SUBPAGES: Record<string, { label: string; icon: typeof ICONS.sbom }> = { sbom: { label: "SBOM", icon: ICONS.sbom }, "base-image": { label: "Base image", icon: ICONS.baseImages } }
  const artifactSubpage = subpage ? ARTIFACT_SUBPAGES[subpage] : undefined
  if (selected && artifactSubpage && selected.digest) {
    const artifactHref = linkTo(containerImageHref(detail.key, selected.artifactKey))
    return (
      <div className="min-h-full flex flex-col items-center">
        <Page>
          <ResourceHeader
            icon={artifactSubpage.icon}
            iconAriaLabel={artifactSubpage.label}
            title={`${artifactSubpage.label} · ${artifactTitle(detail.repository, selected.resolvedTag)}`}
            breadcrumbs={[
              { label: "Container Images", href: linkTo("/container-images", { drop: ["focus"] }) },
              { label: `Image ${detail.key}`, href: linkTo(containerImageHref(detail.key), { drop: ["focus"] }) },
              { label: digestCrumb(selected.digest), href: artifactHref },
              { label: artifactSubpage.label },
            ]}
            subtitle={<span className="break-all font-mono">{selected.digest}</span>}
          />
          <ArtifactNav image={detail.key} artifact={selected.artifactKey} />
          {subpage === "sbom"
            ? <ImageSbom digest={selected.digest} />
            : <BaseImageHierarchy images={selected.usage.imageInfo.platforms ?? []} targetLabel={`${detail.key}@${selected.digest}`} />}
        </Page>
      </div>
    )
  }

  if (selected) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <Page>
          <ArtifactView detail={detail} version={selected} linkTo={linkTo} />
        </Page>
      </div>
    )
  }

  const tags = tagResolution(data, detail.key)
  const driftStyle = SEVERITY_STYLE[detail.worstStatus]
  const firstImage = detail.versions[0]?.usage.imageInfo
  const repositoryUrl = firstImage?.sourceRepositories?.[0]?.url ?? firstImage?.crawlerSource?.url ?? firstImage?.repositoryUrl
  const failureReason = detail.issues[0]
    ? `${detail.issues[0].type}: ${detail.issues[0].message}`
    : detail.versions.some(v => v.tagStatus === "digest_verification_failed")
      ? "The running digest matches no published tag."
      : null

  return (
    <div className="min-h-full flex flex-col items-center">
      <Page>
        <ResourceHeader
          icon={ICONS.containerImages}
          iconAriaLabel="Container image"
          title={detail.repository}
          copyValue={detail.key}
          breadcrumbs={[
            { label: "Container Images", href: linkTo("/container-images", { drop: ["focus"] }) },
            { label: `Image ${detail.key}` },
          ]}
          chips={[{ label: "Image", tone: "brand" }, ...(!isNoData(detail.worstStatus) && driftStyle ? [{label: driftStyle.label, className: `${driftStyle.bg} ${driftStyle.text}`}]:[])]}
          issueCount={detail.issueCount}
          subtitle={
            <span className="flex items-center gap-1.5">
              <span className="font-mono">{detail.registry}</span>
              {repositoryUrl && (
                <>
                  <span>·</span>
                  <PrefetchLink
                    href={linkTo(sourceRepositoryPath(repositoryUrl))}
                    className="font-mono hover:text-brand-text hover:underline"
                  >
                    {repositoryUrl.replace(/^https?:\/\//, "")}
                  </PrefetchLink>
                </>
              )}
            </span>
          }
        />

        <ImageStats detail={detail} />



        <IssuesCard resourceIssues={driftIssues(detail.versions.map(version=>version.usage))} imageIssues={detail.issues} />

        <div className="flex min-w-0 flex-col gap-6">
          <div className="flex min-w-0 flex-col gap-6">
            <VersionsTable imageKey={detail.key} versions={detail.versions} containerCount={detail.containerCount} />
            <DeployedByCard
              rows={detail.workloadRows}
              containerCount={detail.containerCount}
              namespaceCount={detail.namespaceCount}
              showVersions={detail.versions.length > 1}
              linkTo={linkTo}
            />

          </div>
          <div className="flex flex-col gap-6">
            {detail.versions[0] && (
              <>
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
      </Page>
    </div>
  )
}
