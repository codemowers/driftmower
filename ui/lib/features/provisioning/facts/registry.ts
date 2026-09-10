import "server-only"

import { kubeApiGet } from "@/lib/server/k8s"
import { createTtlCache } from "@/lib/utils/ttl-cache"
import { CLUSTER_FACT_TTL_MS } from "../constants"
import {
  registriesInPullSecret,
  summariseRegistries,
  type PullSecretFact,
  type RegistryFact,
} from "../registry-facts"
import type { Fact } from "../types"
import { optional } from "./tolerate"

type RawPod = { spec?: { containers?: { image?: string }[]; initContainers?: { image?: string }[] } }

// Which registries this cluster's own workloads come from. That is how the
// house registry is identified — nobody writes it down anywhere else.
async function loadClusterRegistries(): Promise<Fact<RegistryFact[]>> {
  return await optional("pods", async () => {
    const list = await kubeApiGet<{ items?: RawPod[] }>("/api/v1/pods")
    const images = (list.items ?? []).flatMap(pod => [
      ...(pod.spec?.containers ?? []),
      ...(pod.spec?.initContainers ?? []),
    ].map(c => c.image ?? ""))
    // Pull secrets are namespace-scoped, so coverage is resolved per namespace
    // by the caller below rather than here.
    return summariseRegistries(images, new Set())
  })
}

export const getClusterRegistries = createTtlCache(CLUSTER_FACT_TTL_MS, loadClusterRegistries)

const DOCKERCONFIG_TYPE = "kubernetes.io/dockerconfigjson"
const DOCKERCONFIG_KEY = ".dockerconfigjson"

type RawSecret = {
  metadata?: { name?: string }
  type?: string
  data?: Record<string, string>
}

// Reads the `auths` KEYS of a dockerconfigjson Secret — the registry hostnames
// — and nothing else. No credential is decoded, stored or returned. The
// ServiceAccount already holds `secrets: list` cluster-wide for Helm state, so
// this is not a privilege increase, but the boundary is worth being explicit
// about: hostnames only, because "which registries does this secret cover" is
// the difference between useful advice and a shrug.
export async function getPullSecrets(namespace: string): Promise<Fact<PullSecretFact[]>> {
  return await optional("secrets", async () => {
    const list = await kubeApiGet<{ items?: RawSecret[] }>(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets`,
    )

    return (list.items ?? [])
      .filter(secret => secret.type === DOCKERCONFIG_TYPE && secret.metadata?.name)
      .map(secret => {
        const encoded = secret.data?.[DOCKERCONFIG_KEY]
        const decoded = encoded ? Buffer.from(encoded, "base64").toString("utf8") : ""
        return { name: secret.metadata!.name!, registries: registriesInPullSecret(decoded) }
      })
  })
}
