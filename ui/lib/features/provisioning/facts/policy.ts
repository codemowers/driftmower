import "server-only"

import { kubeApiGet } from "@/lib/server/k8s"
import { createTtlCache } from "@/lib/utils/ttl-cache"
import { CLUSTER_FACT_TTL_MS } from "../constants"
import type { Fact, PolicyFact } from "../types"
import { optional } from "./tolerate"

type RawResourceMatch = { resources?: { kinds?: string[] } }

type RawKyvernoRule = {
  name?: string
  match?: RawResourceMatch & { any?: RawResourceMatch[] }
}

type RawKyvernoPolicy = {
  metadata?: { name?: string }
  spec?: {
    validationFailureAction?: string
    failurePolicy?: string
    rules?: RawKyvernoRule[]
  }
}

// Kinds a rule applies to, flattened out of both the legacy `match.resources`
// and the newer `match.any[]` shapes.
function kindsOf(rule: RawKyvernoRule): string[] {
  const direct = rule.match?.resources?.kinds ?? []
  const any = (rule.match?.any ?? []).flatMap(entry => entry.resources?.kinds ?? [])
  return [...new Set([...direct, ...any])]
}

function toPolicyFact(raw: RawKyvernoPolicy): PolicyFact | null {
  const name = raw.metadata?.name
  if (!name) return null

  // Only Enforce can reject an apply; Audit merely reports, so calling it a
  // risk would be crying wolf.
  const mode = raw.spec?.validationFailureAction === "Enforce" ? "Enforce" : "Audit"
  const touches = (raw.spec?.rules ?? []).flatMap(kindsOf)

  return {
    engine: "kyverno",
    name,
    mode,
    touches: [...new Set(touches)],
    meaning:
      mode === "Enforce"
        ? "This policy can reject the apply. The server-side dry-run below is what tells you for certain."
        : "This policy only reports; it will not block the apply.",
  }
}

async function listPolicies(): Promise<Fact<PolicyFact[]>> {
  return await optional("kyverno clusterpolicies", async () => {
    const list = await kubeApiGet<{ items?: RawKyvernoPolicy[] }>("/apis/kyverno.io/v1/clusterpolicies")
    return (list.items ?? []).map(toPolicyFact).filter((p): p is PolicyFact => p !== null)
  })
}

export const getPolicies = createTtlCache(CLUSTER_FACT_TTL_MS, listPolicies)
