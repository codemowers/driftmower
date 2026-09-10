import "server-only"

import { kubeApiGet } from "@/lib/server/k8s"
import { createTtlCache } from "@/lib/utils/ttl-cache"
import { OPERATOR_TTL_MS } from "../constants"
import type { OperatorHealth } from "../availability"
import type { Fact } from "../types"
import { optional } from "./tolerate"

// Deployments are already granted to this ServiceAccount (k8s/rbac.yaml).
type RawDeployment = {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> }
  spec?: { replicas?: number; template?: { spec?: { containers?: { image?: string; args?: string[] }[] } } }
  status?: { readyReplicas?: number }
}

const VERSION_LABELS = ["app.kubernetes.io/version", "helm.sh/chart"]

function versionOf(deployment: RawDeployment): string | null {
  for (const label of VERSION_LABELS) {
    const value = deployment.metadata?.labels?.[label]
    if (value) return value
  }
  // Fall back to the image tag, which is what a user would read off the pod.
  const image = deployment.spec?.template?.spec?.containers?.[0]?.image
  const tag = image?.split("@")[0].split(":")[1]
  return tag ?? null
}

// Several operators take a watch scope as a flag; reporting it stops us from
// promising an operator will act on a namespace it is not watching.
function watchedNamespacesOf(deployment: RawDeployment): string[] | "all" {
  const args = deployment.spec?.template?.spec?.containers?.[0]?.args ?? []
  for (const arg of args) {
    const match = /^--(?:watch-namespaces?|namespaces?)=(.*)$/.exec(arg)
    if (!match) continue
    const value = match[1].trim()
    if (value === "" || value === "*") return "all"
    return value.split(",").map(v => v.trim()).filter(Boolean)
  }
  return "all"
}

async function listOperatorDeployments(): Promise<Fact<RawDeployment[]>> {
  return await optional("deployments", async () => {
    const list = await kubeApiGet<{ items?: RawDeployment[] }>("/apis/apps/v1/deployments")
    return list.items ?? []
  })
}

const getOperatorDeployments = createTtlCache(OPERATOR_TTL_MS, listOperatorDeployments)

export async function getOperatorHealth(): Promise<Fact<(ref: { namespace: string; deployment: string }) => OperatorHealth | null>> {
  const fact = await getOperatorDeployments()
  if (!fact.known) return fact

  const items = fact.value
  return {
    known: true,
    value: ref => {
      // Prefix match: Helm prepends the release name, so the cnpg chart's
      // controller lands as e.g. "cnpg-cloudnative-pg".
      const match = items.find(
        d =>
          d.metadata?.namespace === ref.namespace &&
          (d.metadata?.name === ref.deployment || d.metadata?.name?.startsWith(ref.deployment) === true),
      )
      if (!match?.metadata?.name) return null

      return {
        deployment: match.metadata.name,
        namespace: ref.namespace,
        readyReplicas: match.status?.readyReplicas ?? 0,
        desiredReplicas: match.spec?.replicas ?? 1,
        version: versionOf(match),
        watchedNamespaces: watchedNamespacesOf(match),
      }
    },
  }
}
