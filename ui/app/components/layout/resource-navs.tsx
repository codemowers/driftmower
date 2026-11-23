"use client"

import { useResourceNavigation } from "@/lib/hooks/use-resource-navigation"
import { useClusterState } from "@/lib/cluster/cluster-state"
import SubpageNav from "./subpage-nav"
import { useNetstatdMissing } from "@/lib/features/netstatd/store"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { containerImageHref } from "@/lib/utils/image-artifacts"

// One nav per resource family, shared by the resource page and its subpages.
// The sidebar lists them as flat sub-items under the resource's section.

export function WorkloadNav({ uid }: { uid: string; namespace?: string; podNames?: string[] }) {
  const { linkTo } = useContextHref()
  const missing = useNetstatdMissing()
  const title = useClusterState(s => s.clusterResources?.find(r => r.uid === uid)?.name ?? s.data?.workloads?.find(w => w.uid === uid)?.name ?? "Workload")
  const base = `/topmost-owners/${uid}`
  useResourceNavigation({ parent: "/topmost-owners", title, href: linkTo(base), items: [
    { label: "Overview", href: linkTo(base) },
    { label: "Logs", href: linkTo(`${base}/logs`) },
    { label: "Network", href: linkTo(`${base}/network-topology`), disabled: missing },
  ] })
  return null
}

export function PodNav({ workloadUid, podUid, pod }: { workloadUid: string; podUid: string; namespace?: string; pod: string }) {
  const { linkTo } = useContextHref()
  const missing = useNetstatdMissing()
  const base = `/topmost-owners/${workloadUid}/${podUid}`
  useResourceNavigation({ parent: "/topmost-owners", title: pod, href: linkTo(base), items: [
    { label: "Overview", href: linkTo(base) },
    { label: "Logs", href: linkTo(`${base}/logs`) },
    { label: "Network", href: linkTo(`${base}/network-topology`), disabled: missing },
  ] })
  return null
}

export function NamespaceNav({ namespace }: { namespace: string }) {
  const { linkTo } = useContextHref()
  const base = `/namespaces/${encodeURIComponent(namespace)}`
  useResourceNavigation({ parent: "/namespaces", title: namespace, href: linkTo(base), items: [
    { label: "Overview", href: linkTo(base) },
    { label: "Logs", href: linkTo(`${base}/logs`) },
  ] })
  return null
}

export function ArtifactNav({ image, artifact }: { image: string; artifact: string }) {
  const { linkTo } = useContextHref()
  return <SubpageNav items={[
    { label: "Overview", href: linkTo(containerImageHref(image, artifact)) },
    { label: "SBOM", href: linkTo(containerImageHref(image, artifact, "sbom")) },
    { label: "Base image", href: linkTo(containerImageHref(image, artifact, "base-image")) },
  ]} />
}
