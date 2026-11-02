import type { ProvisionTarget } from '../../domain/provisioning/access-facts.js'
import type { AdmissionPolicyFact } from '../../domain/provisioning/admission-facts.js'
import {
  negotiateVersion,
  servesGroup,
  type ApiSurface,
  type ServedResource
} from '../../domain/provisioning/api-surface.js'
import { availabilityOf, type OperatorHealth } from '../../domain/provisioning/availability.js'
import { OFFERINGS, type OfferingSpec } from '../../domain/provisioning/catalog/offerings.js'
import { tenantLabelKeyFor, toAdmissionFact } from '../../domain/provisioning/admission-facts.js'
import { defaultsFor, type MutationFact } from '../../domain/provisioning/mutation-facts.js'
import { tlsAdvice, type DomainSuffix } from '../../domain/provisioning/ingress-facts.js'
import { storageFactFromCatalog } from '../../domain/provisioning/storage-facts.js'
import type {
  AdmissionFact,
  DegradedRead,
  OfferingCard,
  OfferingId,
  PolicyFact,
  StorageClassFact,
  TopologyFact
} from '../../domain/provisioning/types.js'
import type { AccessChecker } from '../access-check.js'
import type { ClusterCapabilitiesDiscovery } from '../cluster-capabilities.js'
import type { ClusterCatalog } from '../cluster-catalog.js'
import type { KubernetesReader } from '../observability-kubernetes.js'
import { createTtlMemo, type TtlMemo } from '../ttl-cache.js'
import { createAccessMatrixBuilder, type AccessMatrixBuilder } from './access-matrix.js'
import { loadAdmissionFacts, loadIngressSuffix } from './admission.js'
import { loadApiSurface } from './discovery.js'
import { loadNamespaceFacts, type NamespaceFactsInput, type NamespaceFactsResult } from './namespace.js'
import { loadOperatorDeployments, operatorHealthLookup, type OperatorRef } from './operators.js'
import { loadKyvernoPolicies } from './policy.js'
import { optional } from './tolerate.js'
import { loadTopology } from './topology.js'

// The only impure entry point of the capability layer. Everything downstream
// is a total function over what this returns.

export interface ClusterFacts {
  surface: ApiSurface
  offerings: OfferingCard[]
  // Per offering the resources its sample creates, with the primary plural
  // taken from discovery; null resource when the cluster does not serve it.
  targets: ProvisionTarget[]
  storageClasses: StorageClassFact[]
  topology: TopologyFact
  policies: PolicyFact[]
  admission: AdmissionPolicyFact[]
  // Bound MutatingAdmissionPolicies, for what an operation is rewritten by.
  mutations: MutationFact[]
  admissionPolicies: AdmissionFact[]
  tenantLabelKey: string | null
  ingress: {
    domainSuffix: DomainSuffix | null
    classes: { name: string; controller: string; isDefault: boolean }[]
    clusterIssuers: string[]
    tlsAdvice: string
  }
  priorityClasses: { name: string; value: number; isDefault: boolean; meaning: string }[]
  networkPolicyEngine: 'cilium' | 'native' | 'none' | 'unknown'
  monitoringOperator: boolean
  degraded: DegradedRead[]
}

export interface ProvisioningFacts {
  // Cluster-wide, memoised. Invalidated by the RBAC/CRD watch when present,
  // otherwise by the configured TTLs.
  cluster(): Promise<ClusterFacts>
  // Per namespace, never cached (the access matrix caches its own reviews).
  namespace(
    input: Omit<NamespaceFactsInput, 'targets' | 'tenantLabelKey' | 'admissionFacts' | 'clusterId'>
  ): Promise<NamespaceFactsResult>
  invalidate(): void
}

export interface ProvisioningFactsOptions {
  read: KubernetesReader
  checker: AccessChecker
  catalog: ClusterCatalog
  capabilities: ClusterCapabilitiesDiscovery
  ingressDomainSuffix: string | null
  clusterFactTtlMs: number
  topologyTtlMs: number
  operatorTtlMs: number
  matrixConcurrency?: number
  // Read per call: the identity is discovered after these facts are built.
  clusterId?: () => string | null
  now?: () => number
}

const EMPTY_TOPOLOGY: TopologyFact = { zones: [], schedulableNodes: 0, controlPlaneLabel: null }

export function createProvisioningFacts(options: ProvisioningFactsOptions): ProvisioningFacts {
  const { read, now } = options
  const surface = createTtlMemo(options.clusterFactTtlMs, () => loadApiSurface(read), now)
  const topology = createTtlMemo(options.topologyTtlMs, () => loadTopology(read), now)
  const operators = createTtlMemo(options.operatorTtlMs, () => loadOperatorDeployments(read), now)
  const cluster = createTtlMemo(options.clusterFactTtlMs, () => gather(), now)
  const matrix: AccessMatrixBuilder = createAccessMatrixBuilder({
    surface: () => surface.get(),
    checker: options.checker,
    concurrency: options.matrixConcurrency
  })
  const memos: TtlMemo<unknown>[] = [surface, topology, operators, cluster]

  async function gather(): Promise<ClusterFacts> {
    const degraded: DegradedRead[] = []
    const note = (source: string, fact: { known: boolean; reason?: string; detail?: string }) => {
      // A CRD that is simply not installed is a fact, not a failure; only an
      // RBAC refusal means the deployment needs attention.
      if (!fact.known && fact.reason === 'rbac' && fact.detail)
        degraded.push({ source, status: 403, message: fact.detail })
    }

    const [api, storage, nodes, policies, deployments, admission] = await Promise.all([
      surface.get(),
      optional('storageclasses', async () =>
        (await options.catalog.listStorageClasses()).storageClasses
          .map(storageFactFromCatalog)
          .filter((fact): fact is StorageClassFact => fact !== null)
          .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
      ),
      topology.get(),
      loadKyvernoPolicies(read),
      operators.get(),
      loadAdmissionFacts(options.catalog)
    ])
    const issuerVersion = api.versionsByGroup.get('cert-manager.io')?.[0] ?? null
    const platform = await options.capabilities.listPlatformClasses(issuerVersion)
    const admissionFacts = admission.known ? admission.value.validating : []
    const mutationFacts = admission.known ? admission.value.mutating : []
    const suffix = await loadIngressSuffix(read, admissionFacts, options.ingressDomainSuffix)

    note('storageclasses', storage)
    note('nodes', nodes)
    note('kyverno clusterpolicies', policies)
    note('deployments', deployments)
    note('validatingadmissionpolicies', admission)
    degraded.push(...suffix.degraded)
    degraded.push(
      ...platform.degraded.map(entry => ({ source: entry.source, status: 0, message: entry.message }))
    )

    const lookup = deployments.known
      ? operatorHealthLookup(deployments.value)
      : (): OperatorHealth | null => null
    const cards = OFFERINGS.map(spec => toCard(spec, api, lookup, mutationFacts)).sort(
      (a, b) => rank(a.card) - rank(b.card) || a.card.name.localeCompare(b.card.name)
    )
    const issuers = (platform.clusterIssuers ?? []).map(issuer => ({
      name: issuer.name,
      ready: issuer.ready,
      acme: issuer.acme ?? null
    }))
    const clusterIssuers = issuers.map(issuer => issuer.name)

    return {
      surface: api,
      offerings: cards.map(entry => entry.card),
      targets: cards.map(entry => entry.target),
      storageClasses: storage.known ? storage.value : [],
      topology: nodes.known ? nodes.value : EMPTY_TOPOLOGY,
      policies: policies.known ? policies.value : [],
      admission: admissionFacts,
      mutations: mutationFacts,
      admissionPolicies: admissionFacts.map(toAdmissionFact),
      tenantLabelKey: tenantLabelKeyFor(admissionFacts),
      ingress: {
        domainSuffix: suffix.suffix,
        classes: platform.ingressClasses ?? [],
        clusterIssuers,
        tlsAdvice: tlsAdvice(issuers)
      },
      priorityClasses: (platform.priorityClasses ?? []).map(item => ({
        name: item.name,
        value: item.value,
        isDefault: item.isDefault,
        meaning: priorityMeaning(item)
      })),
      // Cilium owns policy where its CRDs exist, because only entity-based
      // rules can admit node-sourced traffic such as CNPG's health probes.
      networkPolicyEngine: servesGroup(api, 'cilium.io')
        ? 'cilium'
        : servesGroup(api, 'networking.k8s.io')
          ? 'native'
          : 'none',
      monitoringOperator: servesGroup(api, 'monitoring.coreos.com'),
      degraded
    }
  }

  return {
    cluster: () => cluster.get(),
    async namespace(input) {
      const facts = await cluster.get()

      return loadNamespaceFacts(
        { read, matrix },
        {
          ...input,
          targets: facts.targets,
          tenantLabelKey: facts.tenantLabelKey,
          admissionFacts: facts.admission,
          clusterId: options.clusterId?.() ?? null
        }
      )
    },
    invalidate() {
      for (const memo of memos) memo.invalidate()
    }
  }
}

function toCard(
  spec: OfferingSpec,
  surface: ApiSurface,
  lookup: (ref: OperatorRef) => OperatorHealth | null,
  mutations: MutationFact[]
): { card: OfferingCard; target: ProvisionTarget } {
  const served: ServedResource | null = negotiateVersion(surface, spec.group, spec.kind, spec.versions)
  const health = lookup(spec.operatorRef)
  const availability = availabilityOf(served !== null, health, spec.operator.docsHref)
  const target: ProvisionTarget = {
    id: spec.id,
    resources: [
      served
        ? { group: spec.group, resource: served.plural, version: served.version }
        : {
            group: spec.group,
            resource: null,
            reason: `The cluster does not serve ${spec.kind}.${spec.group}, so there is nothing to create yet`
          },
      ...spec.alsoRequires
    ]
  }

  return {
    card: {
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
      admissionDefaults: defaultsFor(mutations, target)
    },
    target
  }
}

function priorityMeaning(item: { isDefault: boolean; description: string | null }): string {
  if (item.isDefault) return 'Applied automatically when a pod names no priority class.'

  const described = item.description?.trim()

  if (described) return described

  return 'Pods with a higher value are scheduled first and evict lower-priority pods when the cluster is full.'
}

// Installed offerings first, so a not-installed catalog sinks below the usable
// one rather than burying it.
function rank(card: OfferingCard): number {
  switch (card.availability.state) {
    case 'ready':
      return 0
    case 'degraded':
      return 1
    case 'crds-only':
      return 2
    default:
      return 3
  }
}

export type { OfferingId }
