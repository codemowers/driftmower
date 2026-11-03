import "server-only"

import { kubeApiGet } from "@/lib/server/k8s"
import { normalizeIp } from "./normalize-ip"

export type NetstatdPod = {
  ip: string
  nodeName: string
}

type PodList = {
  items: {
    spec?: { nodeName?: string }
    status?: { podIP?: string }
  }[]
}

export const NETSTATD_AGENT_PORT = 5280

export function netstatdSelector(): string {
  return process.env.NETSTATD_LABEL_SELECTOR || "app=netstatd"
}

export async function discoverNetstatdPods(): Promise<NetstatdPod[]> {
  const selector = encodeURIComponent(netstatdSelector())
  const list = await kubeApiGet<PodList>(
    `/api/v1/pods?labelSelector=${selector}&fieldSelector=status.phase%3DRunning`,
  )

  const pods: NetstatdPod[] = []
  const seen = new Set<string>()
  for (const item of list.items ?? []) {
    const ip = normalizeIp(item.status?.podIP)
    const nodeName = item.spec?.nodeName
    if (!ip || !nodeName || seen.has(ip)) continue
    seen.add(ip)
    pods.push({ ip, nodeName })
  }
  return pods
}
