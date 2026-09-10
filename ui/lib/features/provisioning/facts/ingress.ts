import "server-only"

import { kubeApiGet } from "@/lib/server/k8s"
import { createTtlCache } from "@/lib/utils/ttl-cache"
import { CLUSTER_FACT_TTL_MS } from "../constants"
import { toIngressClassFact, type IngressClassFact, type RawIngressClass } from "../ingress-facts"
import type { Fact } from "../types"
import { optional } from "./tolerate"

export type IngressPlatformFact = {
  classes: IngressClassFact[]
  clusterIssuers: string[]
  sharedWildcard: boolean
}

type RawClusterIssuer = { metadata?: { name?: string } }

type RawIngress = {
  spec?: { tls?: { hosts?: string[]; secretName?: string }[]; rules?: { host?: string }[] }
}

async function loadIngressPlatform(): Promise<Fact<IngressPlatformFact>> {
  const classes = await optional("ingressclasses", async () => {
    const list = await kubeApiGet<{ items?: RawIngressClass[] }>("/apis/networking.k8s.io/v1/ingressclasses")
    return (list.items ?? [])
      .map(toIngressClassFact)
      .filter((c): c is IngressClassFact => c !== null)
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
  })

  // Absent cert-manager is a fact, not a failure — TLS may be terminated
  // upstream instead.
  const issuers = await optional("cert-manager clusterissuers", async () => {
    const list = await kubeApiGet<{ items?: RawClusterIssuer[] }>("/apis/cert-manager.io/v1/clusterissuers")
    return (list.items ?? []).map(i => i.metadata?.name).filter((n): n is string => Boolean(n))
  })

  // A shared wildcard shows up as Ingresses that serve hosts with no tls block
  // of their own — the pattern this repo's own hosts.ts already comments on.
  const wildcard = await optional("ingresses", async () => {
    const list = await kubeApiGet<{ items?: RawIngress[] }>("/apis/networking.k8s.io/v1/ingresses")
    const items = list.items ?? []
    const withHosts = items.filter(i => (i.spec?.rules ?? []).some(r => Boolean(r.host)))
    if (withHosts.length === 0) return false
    return withHosts.some(i => (i.spec?.tls ?? []).length === 0)
  })

  if (!classes.known) return classes

  return {
    known: true,
    value: {
      classes: classes.value,
      clusterIssuers: issuers.known ? issuers.value : [],
      sharedWildcard: wildcard.known ? wildcard.value : false,
    },
  }
}

export const getIngressPlatform = createTtlCache(CLUSTER_FACT_TTL_MS, loadIngressPlatform)
