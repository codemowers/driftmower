import "server-only"

import type { PeerRef, Protocol } from "../types"
import { hostPortKey, type IpIndex, type PodEntry } from "./ip-index"
import { isWildcardIp } from "./normalize-ip"

export type HostRecord = {
  nodeName: string
  hostIPs: Set<string>
  hostNetNS: number
}

export type ListeningRecord = {
  key: string
  protocol: Protocol
  ip: string
  port: number
  nodeName: string
  netns: number
  isHostNetNS: boolean
  ownerPodUid?: string
}

export type ContainerRecord = {
  podUid?: string
  namespace?: string
  podName?: string
  nodeName?: string
}

export type AttributionTables = {
  index: IpIndex | null
  hosts: Map<string, HostRecord>
  containers: Map<string, ContainerRecord>
  netnsOwner: Map<string, string>
  listeningByPort: Map<string, ListeningRecord[]>
}

export function netnsKey(nodeName: string, netns: number): string {
  return `${nodeName}:${netns}`
}

export function nodeForIp(hosts: Map<string, HostRecord>, ip: string): string | null {
  for (const host of hosts.values()) {
    if (host.hostIPs.has(ip)) return host.nodeName
  }
  return null
}

export function ownerOfListening(t: AttributionTables, record: ListeningRecord): string | undefined {
  if (!t.index) return undefined

  if (!isWildcardIp(record.ip)) {
    const pod = t.index.podByIP.get(record.ip)
    if (pod) return pod.podUid
  }

  if (record.isHostNetNS) {
    return t.index.hostPortOwner.get(hostPortKey(record.nodeName, record.protocol, record.port))
  }

  const containerUid = t.netnsOwner.get(netnsKey(record.nodeName, record.netns))
  if (!containerUid) return undefined
  return t.containers.get(containerUid)?.podUid
}

export function ownerOfLocalEndpoint(
  t: AttributionTables,
  nodeName: string | undefined,
  localIP: string,
  localPort: number | undefined,
  protocol: Protocol,
): PodEntry | undefined {
  if (!t.index) return undefined

  const direct = t.index.podByIP.get(localIP)
  if (direct) return direct

  if (!nodeName || localPort === undefined) return undefined

  const key = hostPortKey(nodeName, protocol, localPort)
  const hostOwner = t.index.hostPortOwner.get(key)
  if (hostOwner) return t.index.podByUid.get(hostOwner)

  for (const record of t.listeningByPort.get(key) ?? []) {
    if (!record.ownerPodUid) continue
    if (record.ip !== localIP && !isWildcardIp(record.ip)) continue
    return t.index.podByUid.get(record.ownerPodUid)
  }
  return undefined
}

export function isLocalPortListening(
  t: AttributionTables,
  nodeName: string | undefined,
  localIP: string,
  localPort: number | undefined,
  protocol: Protocol,
): boolean {
  if (!nodeName || localPort === undefined) return false
  for (const record of t.listeningByPort.get(hostPortKey(nodeName, protocol, localPort)) ?? []) {
    if (record.ip === localIP || isWildcardIp(record.ip)) return true
  }
  return false
}

function workloadPeer(pod: PodEntry): PeerRef {
  return {
    class: "workload",
    ownerKind: pod.owner.kind,
    namespace: pod.owner.namespace,
    name: pod.owner.name,
  }
}

export function peerOf(
  t: AttributionTables,
  ip: string,
  port: number | undefined,
  protocol: Protocol,
  isPrivate: boolean,
): PeerRef {
  if (!t.index) return { class: isPrivate ? "unknown" : "external" }

  const pod = t.index.podByIP.get(ip)
  if (pod) return workloadPeer(pod)

  const service = t.index.serviceByIP.get(ip) ?? t.index.endpointToService.get(ip)
  if (service) {
    return { class: "service", ownerKind: "Service", namespace: service.namespace, name: service.name }
  }

  const node = nodeForIp(t.hosts, ip)
  if (node) {
    // A hostNetwork pod answers on the node's IP, so the declared port is what tells them apart.
    if (port !== undefined) {
      const owner = t.index.hostPortOwner.get(hostPortKey(node, protocol, port))
      const hostPod = owner ? t.index.podByUid.get(owner) : undefined
      if (hostPod) return workloadPeer(hostPod)
    }
    return { class: "node", nodeName: node }
  }

  return { class: isPrivate ? "unknown" : "external" }
}

export function peerKeyOf(peer: PeerRef, ip: string): string {
  switch (peer.class) {
    case "workload":
      return peer.restricted
        ? `w:Pod/${peer.namespace ?? "?"}/~`
        : `w:${peer.ownerKind}/${peer.namespace}/${peer.name}`
    case "service":
      return `s:${peer.namespace}/${peer.name}`
    case "node":
      return `n:${peer.nodeName}`
    default:
      return `i:${ip}`
  }
}
