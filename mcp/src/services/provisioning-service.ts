import type { AccessChecker } from '../clients/access-check.js'
import type { KubernetesIdentity } from '../clients/observability-kubernetes.js'
import type { ClusterFacts, ProvisioningFacts } from '../clients/provisioning-facts/index.js'
import { mapWithConcurrency } from '../clients/concurrency.js'
import { composeCreateVerdict, constraintSentence, type Verdict } from '../domain/provisioning/access-facts.js'
import { admissionFor, type Denial } from '../domain/provisioning/admission-facts.js'
import { mutationsOf } from '../domain/provisioning/mutation-facts.js'
import { OFFERINGS_BY_ID } from '../domain/provisioning/catalog/offerings.js'
import { hostRuleFor, parseCustomDomains, VERIFIED_DOMAINS_ANNOTATION } from '../domain/provisioning/ingress-facts.js'
import type {
  AdmissionDefault,
  CapabilityResponse,
  DegradedRead,
  HostRule,
  NamespaceFact,
  OfferingCard,
  OfferingId,
  StorageClassFact
} from '../domain/provisioning/types.js'

// The provisioning capability layer: cluster facts read natively, per-namespace
// facts confined to what the caller may see, and every permission answer
// asked of the cluster authorizer as the verified caller.
//
// Every result is either `ok` or a named unavailability. The `degraded` list
// travels with the ok results untouched: a fact that could not be read must
// never arrive looking like a fact that was read and came back empty.

export type UnavailableReason = 'kubernetes_unreachable'

export interface Unavailable {
  status: 'unavailable'
  reason: UnavailableReason
  detail: string
}

export interface ProvisioningPlatform {
  status: 'ok'
  storageClasses: StorageClassFact[]
  topology: CapabilityResponse['topology']
  priorityClasses: CapabilityResponse['priorityClasses']
  networkPolicyEngine: CapabilityResponse['networkPolicyEngine']
  monitoringOperator: boolean
  ingress: Omit<CapabilityResponse['ingress'], 'hostRules'>
  policies: CapabilityResponse['policies']
  admissionPolicies: CapabilityResponse['admissionPolicies']
  tenantLabelKey: string | null
  offeringsReady: number
  offeringsTotal: number
  degraded: DegradedRead[]
}

export interface OfferingsListing {
  status: 'ok'
  offerings: OfferingCard[]
  // Set when a namespace was asked about and the caller may not see it.
  withheld: string[]
  degraded: DegradedRead[]
}

export interface NamespaceReadiness {
  status: 'ok'
  requested: string[]
  namespaces: NamespaceFact[]
  hostRules: HostRule[]
  // Requested namespaces whose facts were not returned because the cluster
  // authorizer does not let the caller list pods there (or could not say).
  withheld: string[]
  degraded: DegradedRead[]
}

export interface AccessCheckInput {
  namespace?: string
  verb: string
  group: string
  resource: string
  subresource?: string
  name?: string
}

export interface AccessCheck {
  status: 'ok'
  verdict: Verdict
  reason: string
  rbac: { verdict: Verdict; reason: string | null }
  admission: Denial[]
  // Enforced policies that only shape the object: the operation is allowed if
  // the manifest meets them.
  admissionConstraints: Denial[]
  // Mutating policies that rewrite the object on CREATE or UPDATE, with what
  // each says it sets and requires.
  admissionDefaults: AdmissionDefault[]
  identity: KubernetesIdentity | null
}

export interface ProvisioningServiceDependencies {
  facts: ProvisioningFacts
  checker: AccessChecker
  maxNamespaces: number
  // How many namespaces' facts are gathered at once.
  concurrency?: number
}

export class ProvisioningService {
  readonly maxNamespaces: number

  constructor(private readonly deps: ProvisioningServiceDependencies) {
    this.maxNamespaces = deps.maxNamespaces
  }

  // The one code path behind the JSON route and every tool.
  async capabilities(
    identity: KubernetesIdentity | null,
    query: { namespaces?: string[]; offering?: OfferingId } = {}
  ): Promise<CapabilityResponse & { withheld: string[] }> {
    const cluster = await this.deps.facts.cluster()
    const requested = normalise(query.namespaces ?? [])

    if (requested.length > this.maxNamespaces) {
      throw new Error(`At most ${this.maxNamespaces} namespaces per call (PROVISIONING_MAX_NAMESPACES)`)
    }

    const spec = query.offering ? OFFERINGS_BY_ID.get(query.offering) : undefined
    const target = spec ? (cluster.targets.find(entry => entry.id === spec.id) ?? null) : null
    const results = await mapWithConcurrency(requested, this.deps.concurrency ?? 4, namespace =>
      this.deps.facts.namespace({
        namespace,
        identity,
        offeringLabelKey: spec?.instanceLabelKey ?? null,
        target
      })
    )
    const degraded = [...cluster.degraded]
    const namespaces: NamespaceFact[] = []
    const hostRules: HostRule[] = []
    const withheld: string[] = []

    for (const result of results) {
      const view = result.fact.access?.view ?? 'yes'

      // Facts about a namespace the caller may not see are withheld rather than
      // returned, and the reason travels in `degraded` when it was inconclusive.
      if (identity && view !== 'yes') {
        withheld.push(result.fact.namespace)

        if (view === 'unknown')
          record(degraded, {
            source: 'subjectaccessreviews',
            status: 0,
            message: `Access to ${result.fact.namespace} could not be evaluated by the cluster authorizer; its facts are withheld, not absent.`
          })

        continue
      }

      namespaces.push(result.fact)
      for (const entry of result.degraded) record(degraded, entry)
      hostRules.push(hostRuleFrom(cluster, result.fact, result.labels, result.annotations ?? {}, identity))
    }

    return {
      inCluster: true,
      offerings: cluster.offerings,
      storageClasses: cluster.storageClasses,
      topology: cluster.topology,
      namespaces,
      policies: cluster.policies,
      admissionPolicies: cluster.admissionPolicies,
      ingress: {
        domainSuffix: cluster.ingress.domainSuffix?.value ?? null,
        domainSuffixSource: cluster.ingress.domainSuffix?.source ?? null,
        classes: cluster.ingress.classes,
        clusterIssuers: cluster.ingress.clusterIssuers,
        tlsAdvice: cluster.ingress.tlsAdvice,
        hostRules
      },
      priorityClasses: cluster.priorityClasses,
      networkPolicyEngine: cluster.networkPolicyEngine,
      monitoringOperator: cluster.monitoringOperator,
      degraded,
      withheld
    }
  }

  async describeProvisioningPlatform(): Promise<ProvisioningPlatform | Unavailable> {
    return this.guard(async () => {
      const cluster = await this.deps.facts.cluster()

      return {
        status: 'ok',
        storageClasses: cluster.storageClasses,
        topology: cluster.topology,
        priorityClasses: cluster.priorityClasses,
        networkPolicyEngine: cluster.networkPolicyEngine,
        monitoringOperator: cluster.monitoringOperator,
        ingress: {
          domainSuffix: cluster.ingress.domainSuffix?.value ?? null,
          domainSuffixSource: cluster.ingress.domainSuffix?.source ?? null,
          classes: cluster.ingress.classes,
          clusterIssuers: cluster.ingress.clusterIssuers,
          tlsAdvice: cluster.ingress.tlsAdvice
        },
        policies: cluster.policies,
        admissionPolicies: cluster.admissionPolicies,
        tenantLabelKey: cluster.tenantLabelKey,
        offeringsReady: cluster.offerings.filter(offering => offering.availability.state === 'ready').length,
        offeringsTotal: cluster.offerings.length,
        degraded: cluster.degraded
      }
    })
  }

  async listOfferings(
    identity: KubernetesIdentity | null,
    offering?: OfferingId,
    namespace?: string
  ): Promise<OfferingsListing | Unavailable> {
    return this.guard(async () => {
      const response = await this.capabilities(identity, namespace ? { namespaces: [namespace] } : {})
      const cards = offering ? response.offerings.filter(card => card.id === offering) : response.offerings
      const fact = response.namespaces[0]

      return {
        status: 'ok',
        offerings: fact ? cards.map(card => withVerdict(card, fact)) : cards,
        withheld: response.withheld,
        degraded: response.degraded
      }
    })
  }

  async describeNamespaceReadiness(
    identity: KubernetesIdentity | null,
    namespaces: string[],
    offering?: OfferingId
  ): Promise<NamespaceReadiness | Unavailable> {
    return this.guard(async () => {
      const requested = normalise(namespaces)
      const response = await this.capabilities(identity, { namespaces: requested, offering })

      return {
        status: 'ok',
        requested,
        namespaces: response.namespaces,
        hostRules: response.ingress.hostRules,
        withheld: response.withheld,
        degraded: response.degraded
      }
    })
  }

  // The exact question for anything the matrix does not cover: cluster-scoped
  // resources, subresources, named objects, `proxy`.
  async checkAccess(
    identity: KubernetesIdentity | null,
    input: AccessCheckInput
  ): Promise<AccessCheck | Unavailable> {
    return this.guard(async () => {
      const cluster = await this.deps.facts.cluster()
      const what = `${input.resource}${input.subresource ? `/${input.subresource}` : ''}.${input.group || 'core'}`
      const operation = input.verb.toUpperCase()
      const labels =
        input.namespace && (operation === 'CREATE' || operation === 'UPDATE' || operation === 'DELETE')
          ? (
              await this.deps.facts.namespace({
                namespace: input.namespace,
                identity: null,
                offeringLabelKey: null,
                target: null
              })
            ).labels
          : {}
      const { denials: admission, constraints: admissionConstraints } =
        operation === 'CREATE' || operation === 'UPDATE' || operation === 'DELETE'
          ? admissionFor(cluster.admission, {
              group: input.group,
              resource: input.resource,
              operation,
              namespaceLabels: labels,
              callerGroups: identity?.groups
            })
          : { denials: [], constraints: [] }
      const admissionDefaults =
        operation === 'CREATE' || operation === 'UPDATE'
          ? mutationsOf(cluster.mutations, {
              group: input.group,
              resource: input.subresource ? `${input.resource}/${input.subresource}` : input.resource,
              operation
            })
          : []

      if (!identity) {
        return {
          status: 'ok',
          verdict: 'unknown',
          reason: `The call carried no verified caller, so permission was not checked. Run \`kubectl auth can-i ${input.verb} ${what}\`.`,
          rbac: { verdict: 'unknown', reason: 'no verified caller' },
          admission,
          admissionConstraints,
          admissionDefaults,
          identity: null
        }
      }

      const rbac = await this.deps.checker.mayPerform(identity, {
        namespace: input.namespace,
        verb: input.verb,
        group: input.group,
        resource: input.resource,
        subresource: input.subresource,
        name: input.name
      })
      const composed =
        operation === 'CREATE'
          ? composeCreateVerdict(rbac, admission, what, admissionConstraints)
          : admission.length > 0
            ? {
                verdict: 'no' as const,
                reason: `An enforced admission policy (${admission[0].policy}) governs ${input.verb} on ${what}: ${admission[0].messages.join('. ')}`
              }
            : rbac.verdict === 'yes'
              ? {
                  verdict: 'yes' as const,
                  reason:
                    `Kubernetes RBAC allows ${input.verb} on ${what}.` +
                    (admissionConstraints.length > 0 ? ` ${constraintSentence(admissionConstraints)}` : '')
                }
              : { verdict: rbac.verdict, reason: rbac.reason ?? 'The access review could not be evaluated' }

      return {
        status: 'ok',
        verdict: composed.verdict,
        reason: composed.reason,
        rbac,
        admission,
        admissionConstraints,
        admissionDefaults,
        identity
      }
    })
  }

  private async guard<T>(load: () => Promise<T>): Promise<T | Unavailable> {
    try {
      return await load()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)

      return {
        status: 'unavailable',
        reason: 'kubernetes_unreachable',
        detail: `The Kubernetes API could not be read: ${detail}`
      }
    }
  }
}

function normalise(namespaces: string[]): string[] {
  return [...new Set(namespaces.map(namespace => namespace.trim()).filter(Boolean))]
}

function record(degraded: DegradedRead[], entry: DegradedRead): void {
  // One row per fact family, not per namespace: the fix is the same rule.
  if (!degraded.some(existing => existing.source === entry.source)) degraded.push(entry)
}

// The namespace's composed verdict for this offering: RBAC across everything
// the offering creates, with enforced admission policies applied.
function withVerdict(card: OfferingCard, fact: NamespaceFact): OfferingCard {
  const verdict = fact.offerings[card.id]

  return verdict
    ? { ...card, mayCreate: verdict.verdict, mayCreateReason: verdict.reason }
    : { ...card, mayCreate: 'unknown', mayCreateReason: 'This offering was not checked here.' }
}

// The hostname a namespace may claim. Only an enforced ingress guard that
// scopes on a tenant label yields a pattern; anything else gets an honest
// note rather than a fabricated rule.
function hostRuleFrom(
  cluster: ClusterFacts,
  fact: NamespaceFact,
  labels: Record<string, string>,
  annotations: Record<string, string>,
  identity: KubernetesIdentity | null
): HostRule {
  const suffix = cluster.ingress.domainSuffix
  // The host guard shapes Ingresses rather than forbidding them, so whichever
  // way its effect reads, it is the policy the host rule comes from.
  const ingressAdmission = admissionFor(cluster.admission, {
    group: 'networking.k8s.io',
    resource: 'ingresses',
    operation: 'CREATE',
    namespaceLabels: labels,
    callerGroups: identity?.groups
  })
  const guard =
    ingressAdmission.denials[0] ??
    ingressAdmission.constraints.find(constraint => constraint.messages.some(message => /host/i.test(message)))
  // The message about hosts, not one about some other resource the guard
  // also covers.
  const hostMessage = guard?.messages.find(m => /host/i.test(m)) ?? guard?.messages[0] ?? null
  const tenantId = fact.tenant?.id ?? null
  const base = {
    namespace: fact.namespace,
    tenantId,
    sandboxId: tenantId,
    enforcedBy: guard?.policy ?? null,
    enforcedMessage: hostMessage,
    customDomains: [] as string[]
  }

  if (!suffix) {
    return {
      ...base,
      exactHost: null,
      labelledPattern: null,
      note: 'This cluster publishes no ingress domain, so ask the platform team which hostnames you may use.'
    }
  }

  if (!guard || !tenantId) {
    return {
      ...base,
      exactHost: null,
      labelledPattern: null,
      note: guard
        ? `The ${guard.policy} admission policy governs Ingress creation here, but this namespace carries no tenant label it scopes on; its message is reported as-is.`
        : `No admission policy enforces a hostname pattern on this namespace; hostnames under ${suffix.value} are a convention, not a rule.`
    }
  }

  // What the guard's own CEL reads decides the shape: anchored on the namespace
  // or on the tenant id, and whether verified custom domains count.
  const policy = cluster.admission.find(fact => fact.name === guard.policy)
  const customDomains = policy?.namespaceAnnotationKeys.includes(VERIFIED_DOMAINS_ANNOTATION)
    ? parseCustomDomains(annotations[VERIFIED_DOMAINS_ANNOTATION])
    : []
  const rule = hostRuleFor(suffix.value, tenantId, guard.policy, {
    namespace: fact.namespace,
    anchorsOnNamespace: policy?.anchorsOnNamespace ?? false,
    customDomains
  })
  const provenance =
    suffix.source === 'config'
      ? " The domain comes from this server's configuration rather than from the guard's own parameters, so confirm it before relying on it."
      : ''

  const anchor = rule.anchorsOnNamespace ? 'namespace anchor' : 'tenant-id prefix'
  const custom = customDomains.length
    ? ` Names under ${customDomains.join(', ')} are accepted too: custom domains verified for this namespace's owners. ` +
      `Point each such hostname at the cluster with a CNAME to ${rule.exactHost} (a bare domain needs the DNS provider's ` +
      'ALIAS/ANAME or CNAME flattening, not A records), write the full hostname in the Ingress, and give it a certificate as the TLS advice says.'
    : ''

  return {
    ...base,
    exactHost: rule.exactHost,
    labelledPattern: rule.labelledPattern,
    customDomains,
    note:
      `Only these hostnames are accepted here, and the ${guard.policy} admission policy enforces it: the ingress controller is shared, and the ${anchor} is what keeps one tenant from claiming another's traffic.` +
      custom +
      provenance
  }
}
