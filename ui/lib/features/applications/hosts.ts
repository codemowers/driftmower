import "server-only"

import { kubeApiGet } from "@/lib/server/k8s"
import { managerFromAnnotations } from "@/lib/cluster-resources/manager"
import { createTtlCache } from "@/lib/utils/ttl-cache"
import type { HostEntry } from "./types"

const CACHE_TTL_MS = 30_000
const ACME_SOLVER_PREFIX = "cm-acme-http-solver-"

type IngressList = {
  items: {
    metadata: {
      name: string
      namespace: string
      annotations?: Record<string, string>
    }
    spec?: { rules?: { host?: string }[] }
  }[]
}

async function listHostEntries(): Promise<HostEntry[]> {
  const list = await kubeApiGet<IngressList>("/apis/networking.k8s.io/v1/ingresses")
  const argoUrl = process.env.ARGO_URL?.trim().replace(/\/+$/, "")
  const byHost = new Map<string, HostEntry>()

  for (const item of list.items) {
    if (item.metadata.name.startsWith(ACME_SOLVER_PREFIX)) continue

    for (const rule of item.spec?.rules ?? []) {
      const host = rule.host
      if (!host) continue

      const existing = byHost.get(host)
      if (existing) {
        if (!existing.ingressNames.includes(item.metadata.name)) {
          existing.ingressNames.push(item.metadata.name)
        }
        continue
      }

      const manager = managerFromAnnotations(item.metadata.annotations, argoUrl)
      byHost.set(host, {
        host,
        // A shared wildcard cert terminates TLS, so an empty spec.tls is not plain HTTP.
        url: `https://${host}`,
        name: item.metadata.name,
        namespace: item.metadata.namespace,
        ingressNames: [item.metadata.name],
        managerUID: manager?.managerUID,
        argoApp: manager?.argoApp,
      })
    }
  }

  return [...byHost.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// ServiceAccount data, identical for every caller; per-user filtering happens above.
export const getHostEntries = createTtlCache(CACHE_TTL_MS, listHostEntries)
