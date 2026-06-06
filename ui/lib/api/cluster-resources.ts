import { isInCluster, kubeApiGet } from "./k8s"
import type { ClusterResource } from "@/lib/cluster/cluster-state"

type OwnerRef = { apiVersion: string; kind: string; name: string; uid: string }

type RawObject = {
  metadata: {
    uid: string
    name: string
    namespace?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    ownerReferences?: OwnerRef[]
  }
  spec?: { nodeName?: string }
  status?: { phase?: string; podIP?: string; podIPs?: { ip: string }[] }
}

type KubeList = { items: RawObject[] }

const SOURCES = [
  { path: "/api/v1/pods", kind: "Pod", apiGroup: "v1" },
  { path: "/apis/apps/v1/deployments", kind: "Deployment", apiGroup: "apps/v1" },
  { path: "/apis/apps/v1/replicasets", kind: "ReplicaSet", apiGroup: "apps/v1" },
  { path: "/apis/apps/v1/statefulsets", kind: "StatefulSet", apiGroup: "apps/v1" },
  { path: "/apis/apps/v1/daemonsets", kind: "DaemonSet", apiGroup: "apps/v1" },
] as const

export async function getClusterResources(): Promise<ClusterResource[]> {
  if (!isInCluster()) return []

  const lists = await Promise.all(
    SOURCES.map(async source => ({
      source,
      items: (await kubeApiGet<KubeList>(source.path)).items ?? [],
    })),
  )

  const raws = lists.flatMap(({ source, items }) =>
    items.map(obj => ({ obj, kind: source.kind, apiGroup: source.apiGroup })),
  )

  const ownerOf = new Map<string, string | undefined>()
  const directManager = new Map<string, string | undefined>()
  for (const { obj } of raws) {
    ownerOf.set(obj.metadata.uid, obj.metadata.ownerReferences?.[0]?.uid)
    directManager.set(obj.metadata.uid, managerFromAnnotations(obj.metadata.annotations))
  }

  function resolveManager(uid: string | undefined, seen = new Set<string>()): string | undefined {
    if (!uid || seen.has(uid)) return undefined
    seen.add(uid)
    const own = directManager.get(uid)
    if (own) return own
    return resolveManager(ownerOf.get(uid), seen)
  }

  const resources = raws.map(({ obj, kind, apiGroup }) =>
    toClusterResource(obj, kind, apiGroup, resolveManager(obj.metadata.uid)),
  )

  addCrdStubs(resources, raws)
  return resources
}

function managerFromAnnotations(annotations?: Record<string, string>): string | undefined {
  if (!annotations) return undefined

  const releaseName = annotations["meta.helm.sh/release-name"]
  const releaseNamespace = annotations["meta.helm.sh/release-namespace"]
  if (releaseName && releaseNamespace) return `helm-release:${releaseNamespace}:${releaseName}`

  const trackingId = annotations["argocd.argoproj.io/tracking-id"]
  if (trackingId) {
    const appName = trackingId.split(":")[0]
    if (appName) return `argo-app:argocd:${appName}`
  }

  return undefined
}

function toClusterResource(
  obj: RawObject,
  kind: string,
  apiGroup: string,
  managerUID: string | undefined,
): ClusterResource {
  const meta = obj.metadata
  const resource: ClusterResource = {
    uid: meta.uid,
    kind,
    apiGroup,
    name: meta.name,
    namespace: meta.namespace ?? "",
  }
  if (meta.labels) resource.labels = meta.labels

  const ownerUID = meta.ownerReferences?.[0]?.uid
  if (ownerUID) resource.ownerUID = ownerUID
  if (managerUID) resource.managerUID = managerUID

  if (kind === "Pod") {
    const ips = obj.status?.podIPs?.map(entry => entry.ip).filter(Boolean)
      ?? (obj.status?.podIP ? [obj.status.podIP] : [])
    if (ips.length) resource.ips = ips
    if (obj.spec?.nodeName) resource.nodeName = obj.spec.nodeName
    if (obj.status?.phase) resource.phase = obj.status.phase
  }

  return resource
}

function addCrdStubs(resources: ClusterResource[], raws: { obj: RawObject }[]): void {
  const present = new Set(resources.map(resource => resource.uid))
  const stubs = new Map<string, ClusterResource>()

  for (const { obj } of raws) {
    const ref = obj.metadata.ownerReferences?.[0]
    if (!ref || present.has(ref.uid) || stubs.has(ref.uid)) continue
    stubs.set(ref.uid, {
      uid: ref.uid,
      kind: ref.kind,
      apiGroup: ref.apiVersion,
      name: ref.name,
      namespace: obj.metadata.namespace ?? "",
    })
  }

  resources.push(...stubs.values())
}
