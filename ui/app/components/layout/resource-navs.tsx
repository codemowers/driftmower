"use client"

import SubpageNav from "./subpage-nav"
import { useNetstatdMissing } from "@/lib/features/netstatd/store"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { containerImageHref } from "@/lib/utils/image-artifacts"

// One nav per resource family, shared by the resource page and its subpages.
// Subpage links live in the page navbar; resource ancestry lives in breadcrumbs.

export function WorkloadNav({ uid }: { uid: string; namespace?: string; podNames?: string[] }) {
  const { linkTo } = useContextHref()
  const missing = useNetstatdMissing()
  const base = `/topmost-owners/${uid}`
  return <SubpageNav items={[
    { label: "Overview", href: linkTo(base) },
    { label: "Logs", href: linkTo(`${base}/logs`) },
    { label: "Network", href: linkTo(`${base}/network-topology`), disabled: missing },
  ]} />
}

export function PodNav({ workloadUid, podUid }: { workloadUid: string; podUid: string; namespace?: string; pod: string }) {
  const { linkTo } = useContextHref()
  const missing = useNetstatdMissing()
  const base = `/topmost-owners/${workloadUid}/${podUid}`
  return <SubpageNav items={[
    { label: "Overview", href: linkTo(base) },
    { label: "Logs", href: linkTo(`${base}/logs`) },
    { label: "Network", href: linkTo(`${base}/network-topology`), disabled: missing },
  ]} />
}

export function NamespaceNav({ namespace }: { namespace: string }) {
  const { linkTo } = useContextHref()
  const base = `/namespaces/${encodeURIComponent(namespace)}`
  return <SubpageNav items={[
    { label: "Overview", href: linkTo(base) },
    { label: "Logs", href: linkTo(`${base}/logs`) },
  ]} />
}

export function ArtifactNav({ image, artifact }: { image: string; artifact: string }) {
  const { linkTo } = useContextHref()
  return <SubpageNav items={[
    { label: "Overview", href: linkTo(containerImageHref(image, artifact)) },
    { label: "SBOM", href: linkTo(containerImageHref(image, artifact, "sbom")) },
    { label: "Base image", href: linkTo(containerImageHref(image, artifact, "base-image")) },
  ]} />
}
