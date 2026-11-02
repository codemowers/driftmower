import "server-only"

import type { ClusterResource } from "@/lib/cluster/cluster-state"
import { getClusterResources } from "@/lib/cluster-resources/resources"
import { KubeApiError, kubeApiGet } from "@/lib/server/k8s"
import { normalizeIp } from "./normalize-ip"

export type OwnerRef = {
  kind: string
  namespace: string
  name: string
}

export type PodEntry = {
  podUid: string
  namespace: string
  podName: string
  nodeName?: string
  owner: OwnerRef
}

export type ServiceRef = {
  namespace: string
  name: string
}

export type IpIndex = {
  builtAt: number
  podByIP: Map<string, PodEntry>
  podByUid: Map<string, PodEntry>
  serviceByIP: Map<string, ServiceRef>
  endpointToService: Map<string, ServiceRef>
  hostPortOwner: Map<string, string>
  resources: ClusterResource[]
}

type ListMeta = { metadata?: { continue?: string } }

type ServiceList = ListMeta & {
  items: {
    metadata?: { name?: string; namespace?: string }
    spec?: { clusterIP?: string; clusterIPs?: string[]; externalIPs?: string[] }
    status?: { loadBalancer?: { ingress?: { ip?: string }[] } }
  }[]
}

type EndpointSliceList = ListMeta & {
  items: {
    metadata?: { namespace?: string; labels?: Record<string, string> }
    endpoints?: { addresses?: string[] }[]
  }[]
}

const PAGE_SIZE = 500

async function listAll<T extends ListMeta>(basePath: string, onPage: (page: T) => void): Promise<void> {
  let restarted = false
  let cont = ""
  for (;;) {
    const sep = basePath.includes("?") ? "&" : "?"
    const path = `${basePath}${sep}limit=${PAGE_SIZE}${cont ? `&continue=${encodeURIComponent(cont)}` : ""}`
    let page: T
    try {
      page = await kubeApiGet<T>(path)
    } catch (e) {
      // An expired continue token is only recoverable by starting the listing over.
      if (e instanceof KubeApiError && e.status === 410 && !restarted) {
        restarted = true
        cont = ""
        continue
      }
      throw e
    }
    onPage(page)
    cont = page.metadata?.continue ?? ""
    if (!cont) return
  }
}

function emptyIndex(): IpIndex {
  return {
    builtAt: Date.now(),
    podByIP: new Map(),
    podByUid: new Map(),
    serviceByIP: new Map(),
    endpointToService: new Map(),
    hostPortOwner: new Map(),
    resources: [],
  }
}

function topmostOwner(pod: ClusterResource, byUid: Map<string, ClusterResource>): OwnerRef {
  let current: ClusterResource = pod
  const seen = new Set<string>([pod.uid])
  while (current.ownerUID) {
    const next = byUid.get(current.ownerUID)
    if (!next || seen.has(next.uid)) break
    seen.add(next.uid)
    current = next
  }
  return { kind: current.kind, namespace: current.namespace, name: current.name }
}

export async function buildIpIndex(): Promise<IpIndex> {
  const index = emptyIndex()

  const [resources] = await Promise.all([
    getClusterResources(),
    listAll<ServiceList>("/api/v1/services", page => {
      for (const item of page.items ?? []) {
        const name = item.metadata?.name
        const namespace = item.metadata?.namespace
        if (!name || !namespace) continue
        const ref: ServiceRef = { namespace, name }
        const candidates = [
          ...(item.spec?.clusterIPs ?? [item.spec?.clusterIP]),
          ...(item.spec?.externalIPs ?? []),
          ...(item.status?.loadBalancer?.ingress ?? []).map(i => i.ip),
        ]
        for (const raw of candidates) {
          if (!raw || raw === "None") continue
          const ip = normalizeIp(raw)
          if (ip) index.serviceByIP.set(ip, ref)
        }
      }
    }),
    listAll<EndpointSliceList>("/apis/discovery.k8s.io/v1/endpointslices", page => {
      for (const item of page.items ?? []) {
        const namespace = item.metadata?.namespace
        const name = item.metadata?.labels?.["kubernetes.io/service-name"]
        if (!namespace || !name) continue
        const ref: ServiceRef = { namespace, name }
        for (const endpoint of item.endpoints ?? []) {
          for (const raw of endpoint.addresses ?? []) {
            const ip = normalizeIp(raw)
            if (ip) index.endpointToService.set(ip, ref)
          }
        }
      }
    }),
  ])

  index.resources = resources
  const byUid = new Map(resources.map(r => [r.uid, r]))

  for (const resource of resources) {
    if (resource.kind !== "Pod") continue
    const entry: PodEntry = {
      podUid: resource.uid,
      namespace: resource.namespace,
      podName: resource.name,
      nodeName: resource.nodeName,
      owner: topmostOwner(resource, byUid),
    }
    index.podByUid.set(resource.uid, entry)

    // A hostNetwork pod's IP is the node's, so indexing it would claim the node for that pod.
    if (!resource.hostNetwork) {
      for (const raw of resource.ips ?? []) {
        const ip = normalizeIp(raw)
        if (ip) index.podByIP.set(ip, entry)
      }
      continue
    }

    if (!resource.nodeName) continue
    for (const port of resource.declaredPorts ?? []) {
      index.hostPortOwner.set(hostPortKey(resource.nodeName, port.protocol, port.port), resource.uid)
    }
  }

  return index
}

export function hostPortKey(nodeName: string, protocol: string, port: number): string {
  return `${nodeName}:${protocol.toUpperCase()}:${port}`
}
