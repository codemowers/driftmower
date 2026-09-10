import "server-only"

import { isInCluster } from "@/lib/server/k8s"
import { availabilityOf } from "../availability"
import { negotiateVersion, servesGroup } from "../api-surface"
import { OFFERINGS } from "../catalog/offerings"
import { tlsAdvice } from "../ingress-facts"
import type { CapabilityResponse, DegradedRead, IngressFact, OfferingCard } from "../types"
import { getApiSurface } from "./discovery"
import { getOperatorHealth } from "./operators"
import { getAdmissionFacts, getIngressSuffix } from "./admission"
import { getIngressPlatform } from "./ingress"
import { getPolicies } from "./policy"
import { getPriorityClasses } from "./scheduling"
import { getStorageClasses } from "./storage"
import { getTopology } from "./topology"

// The only impure entrypoint in the feature. Everything downstream — the
// catalog and the planner — is a total function over what this returns, which
// is what makes the interesting logic unit-testable with no cluster at all.

const EMPTY_TOPOLOGY = { zones: [], schedulableNodes: 0, controlPlaneLabel: null }

const EMPTY_INGRESS: IngressFact = {
  domainSuffix: null,
  domainSuffixSource: null,
  classes: [],
  clusterIssuers: [],
  sharedWildcard: false,
  tlsAdvice: "",
  hostRules: [],
}

export async function gatherClusterFacts(): Promise<CapabilityResponse> {
  if (!isInCluster()) {
    return {
      inCluster: false,
      offerings: [],
      storageClasses: [],
      topology: EMPTY_TOPOLOGY,
      namespaces: [],
      policies: [],
      admissionPolicies: [],
      ingress: EMPTY_INGRESS,
      priorityClasses: [],
      networkPolicyEngine: "unknown",
      monitoringOperator: false,
      degraded: [],
    }
  }

  const degraded: DegradedRead[] = []
  const note = (source: string, fact: { known: boolean; reason?: string; detail?: string }) => {
    // A CRD that is simply not installed is a fact, not a failure; only an RBAC
    // refusal means the deployment needs attention.
    if (!fact.known && fact.reason === "rbac" && fact.detail) {
      degraded.push({ source, status: 403, message: fact.detail })
    }
  }

  const [surface, storage, topology, policies, priorityClasses, operators, admission, suffix, ingress] =
    await Promise.all([
      getApiSurface(),
      getStorageClasses(),
      getTopology(),
      getPolicies(),
      getPriorityClasses(),
      getOperatorHealth(),
      getAdmissionFacts(),
      getIngressSuffix(),
      getIngressPlatform(),
    ])

  note("storageclasses", storage)
  note("nodes", topology)
  note("kyverno clusterpolicies", policies)
  note("priorityclasses", priorityClasses)
  note("deployments", operators)
  note("validatingadmissionpolicies", admission)
  note("ingressclasses", ingress)

  const lookupOperator = operators.known ? operators.value : () => null

  const offerings: OfferingCard[] = OFFERINGS.map(spec => {
    const served = negotiateVersion(surface, spec.group, spec.kind, spec.versions)
    const health = lookupOperator(spec.operatorRef)
    const availability = availabilityOf(served !== null, health, spec.operator.docsHref)

    return {
      id: spec.id,
      name: spec.name,
      purpose: spec.purpose,
      what: spec.what,
      goodFor: spec.goodFor,
      operator: spec.operator,
      resource: served ? `${served.plural}.${spec.group}` : null,
      apiVersion: served ? `${spec.group}/${served.version}` : null,
      availability,
      presets: spec.presets,
      needs: spec.needs,
      // Filled in by the instances endpoint, which is namespace-scoped; the
      // capability view is cluster-wide and deliberately does not fan out.
      instanceCount: 0,
    }
  }).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))

  return {
    inCluster: true,
    offerings,
    storageClasses: storage.known ? storage.value : [],
    topology: topology.known ? topology.value : EMPTY_TOPOLOGY,
    namespaces: [],
    policies: policies.known ? policies.value : [],
    // paramRef is deliberately not forwarded: it is a pointer we follow
    // server-side to read the guard's ConfigMap, and a client has no use for it.
    admissionPolicies: admission.known
      ? admission.value.map(fact => ({
          name: fact.name,
          enforced: fact.enforced,
          enforcement: fact.enforcement,
          guards: fact.guards,
          messages: fact.messages,
          scopedToNamespaceLabels: fact.scopedToNamespaceLabels,
        }))
      : [],
    ingress: {
      domainSuffix: suffix.known ? (suffix.value?.value ?? null) : null,
      domainSuffixSource: suffix.known ? (suffix.value?.source ?? null) : null,
      classes: ingress.known ? ingress.value.classes : [],
      clusterIssuers: ingress.known ? ingress.value.clusterIssuers : [],
      sharedWildcard: ingress.known ? ingress.value.sharedWildcard : false,
      tlsAdvice: ingress.known
        ? tlsAdvice(ingress.value.clusterIssuers, ingress.value.sharedWildcard)
        : "",
      // Host rules are per namespace, so the route fills them in once it knows
      // which namespaces the caller may see.
      hostRules: [],
    },
    priorityClasses: priorityClasses.known ? priorityClasses.value : [],
    // Cilium owns policy where its CRDs exist, because only entity-based rules
    // can admit node-sourced traffic such as CNPG's health probes.
    networkPolicyEngine: servesGroup(surface, "cilium.io")
      ? "cilium"
      : servesGroup(surface, "networking.k8s.io")
        ? "native"
        : "none",
    monitoringOperator: servesGroup(surface, "monitoring.coreos.com"),
    degraded,
  }
}

// Installed offerings first, so a not-installed catalog sinks below the usable
// one rather than burying it.
function rank(card: OfferingCard): number {
  switch (card.availability.state) {
    case "ready":
      return 0
    case "degraded":
      return 1
    case "crds-only":
      return 2
    default:
      return 3
  }
}
