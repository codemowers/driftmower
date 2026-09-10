import "server-only"

import { kubeApiGet } from "@/lib/server/k8s"
import { createTtlCache } from "@/lib/utils/ttl-cache"
import {
  toAdmissionFacts,
  type AdmissionPolicyFact,
  type RawAdmissionBinding,
  type RawAdmissionPolicy,
} from "../admission-facts"
import { CLUSTER_FACT_TTL_MS } from "../constants"
import { suffixFromParams } from "../ingress-facts"
import type { Fact } from "../types"
import { optional } from "./tolerate"

// ValidatingAdmissionPolicies are the real gate on these clusters — they
// override RBAC, and there are no Kyverno policies here at all. Reading them is
// what makes both the permission verdict and the ingress host rule truthful.

const POLICIES = "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicies"
const BINDINGS = "/apis/admissionregistration.k8s.io/v1/validatingadmissionpolicybindings"

async function loadAdmissionFacts(): Promise<Fact<AdmissionPolicyFact[]>> {
  return await optional("validatingadmissionpolicies", async () => {
    const [policies, bindings] = await Promise.all([
      kubeApiGet<{ items?: RawAdmissionPolicy[] }>(POLICIES),
      kubeApiGet<{ items?: RawAdmissionBinding[] }>(BINDINGS),
    ])
    return toAdmissionFacts(policies.items ?? [], bindings.items ?? [])
  })
}

export const getAdmissionFacts = createTtlCache(CLUSTER_FACT_TTL_MS, loadAdmissionFacts)

type RawConfigMap = { data?: Record<string, string> }

// A parameterised policy names the ConfigMap holding its parameters, and for
// the ingress guard that parameter IS the answer to "what hostname may I use".
// Reading the key the guard reads beats inferring the domain from existing
// Ingresses, which would happily hand back the platform's own domain — a
// hostname no sandbox may claim.
async function loadIngressSuffix(): Promise<Fact<string | null>> {
  const facts = await getAdmissionFacts()
  if (!facts.known) return facts

  const guard = facts.value.find(
    fact => fact.paramRef !== null && fact.guards.some(g => g.resource === "ingresses"),
  )
  if (!guard?.paramRef) return { known: true, value: null }

  const namespace = guard.paramRef.namespace ?? "kube-system"
  return await optional("configmaps", async () => {
    const configMap = await kubeApiGet<RawConfigMap>(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${encodeURIComponent(guard.paramRef!.name)}`,
    )
    return suffixFromParams(configMap.data)
  })
}

export const getIngressSuffix = createTtlCache(CLUSTER_FACT_TTL_MS, loadIngressSuffix)
