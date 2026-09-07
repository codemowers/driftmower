import "server-only"

import { isInCluster, kubeApiGet } from "@/lib/server/k8s"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import { managerFromAnnotations, type ManagerInfo } from "./manager"
import { derivePodStatus, type ContainerStatus } from "./pod-status"

type OwnerRef = { apiVersion: string; kind: string; name: string; uid: string }

type RawContainer = {
  name: string
  restartPolicy?: string
  ports?: { containerPort: number; name?: string; protocol?: string }[]
}

type RawObject = {
  metadata: {
    uid: string
    name: string
    namespace?: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    ownerReferences?: OwnerRef[]
    deletionTimestamp?: string
  }
  spec?: {
    nodeName?: string
    containers?: RawContainer[]
    initContainers?: RawContainer[]
  }
  status?: {
    phase?: string
    reason?: string
    podIP?: string
    podIPs?: { ip: string }[]
    containerStatuses?: ContainerStatus[]
    initContainerStatuses?: ContainerStatus[]
  }
}

type KubeList = { items: RawObject[] }

const SOURCES = [
  { path: "/api/v1/pods", kind: "Pod" },
  { path: "/apis/apps/v1/deployments", kind: "Deployment" },
  { path: "/apis/apps/v1/replicasets", kind: "ReplicaSet" },
  { path: "/apis/apps/v1/statefulsets", kind: "StatefulSet" },
  { path: "/apis/apps/v1/daemonsets", kind: "DaemonSet" },
] as const

export async function getClusterResources(): Promise<ClusterResource[]> {
  if (!isInCluster()) {
    console.warn("[kube-api] cluster-resources: Kubernetes API not reachable (KUBERNETES_SERVICE_HOST unset, e.g. localhost) — returning empty")
    return []
  }

  const argoUrl = process.env.ARGO_URL?.trim().replace(/\/+$/, "")

  const lists = await Promise.all(
    SOURCES.map(async source => ({
      source,
      items: (await kubeApiGet<KubeList>(source.path)).items ?? [],
    })),
  )

  const raws = lists.flatMap(({ source, items }) =>
    items.map(obj => ({ obj, kind: source.kind })),
  )

  const ownerOf = new Map<string, string | undefined>()
  const directManager = new Map<string, ManagerInfo | undefined>()
  for (const { obj } of raws) {
    ownerOf.set(obj.metadata.uid, obj.metadata.ownerReferences?.[0]?.uid)
    directManager.set(obj.metadata.uid, managerFromAnnotations(obj.metadata.annotations, argoUrl))
  }

  function resolveManager(uid: string | undefined, seen = new Set<string>()): ManagerInfo | undefined {
    if (!uid || seen.has(uid)) return undefined
    seen.add(uid)
    const own = directManager.get(uid)
    if (own) return own
    return resolveManager(ownerOf.get(uid), seen)
  }

  const resources = raws.map(({ obj, kind }) =>
    toClusterResource(obj, kind, resolveManager(obj.metadata.uid)),
  )

  addCrdStubs(resources, raws)
  return resources
}

function toClusterResource(
  obj: RawObject,
  kind: string,
  manager: ManagerInfo | undefined,
): ClusterResource {
  const meta = obj.metadata
  const resource: ClusterResource = {
    uid: meta.uid,
    kind,
    name: meta.name,
    namespace: meta.namespace ?? "",
  }
  if (meta.labels) resource.labels = meta.labels

  const ownerUID = meta.ownerReferences?.[0]?.uid
  if (ownerUID) resource.ownerUID = ownerUID
  if (manager) {
    resource.managerUID = manager.managerUID
    if (manager.argoApp) resource.argoApp = manager.argoApp
  }

  if (kind === "Pod") {
    const ips = obj.status?.podIPs?.map(entry => entry.ip).filter(Boolean)
      ?? (obj.status?.podIP ? [obj.status.podIP] : [])
    if (ips.length) resource.ips = ips
    const declaredPorts = declaredPodPorts(obj.spec)
    if (declaredPorts.length) resource.declaredPorts = declaredPorts
    if (obj.spec?.nodeName) resource.nodeName = obj.spec.nodeName
    if (obj.status?.phase) resource.phase = obj.status.phase
    resource.podStatus = derivePodStatus(meta.deletionTimestamp, obj.status)
  }

  return resource
}

function declaredPodPorts(spec: RawObject["spec"]) {
  const sidecars = spec?.initContainers?.filter(c => c.restartPolicy === "Always") ?? []
  const containers = [...(spec?.containers ?? []), ...sidecars]
  return containers.flatMap(container =>
    (container.ports ?? []).map(port => ({
      container: container.name,
      ...(port.name ? { name: port.name } : {}),
      port: port.containerPort,
      protocol: port.protocol ?? "TCP",
    })),
  )
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
      name: ref.name,
      namespace: obj.metadata.namespace ?? "",
    })
  }

  resources.push(...stubs.values())
}
