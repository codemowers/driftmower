import {
  mayCreateVerdict,
  summariseMatrix,
  type ProvisionTarget
} from '../../domain/provisioning/access-facts.js'
import { admissionFor, type AdmissionPolicyFact } from '../../domain/provisioning/admission-facts.js'
import {
  computeHeadroom,
  containerDefaults,
  detectPosture,
  extractSelectors,
  type RawCiliumPolicy,
  type RawLimitRange,
  type RawNetworkPolicy,
  type RawResourceQuota
} from '../../domain/provisioning/namespace-facts.js'
import { podSecurityFor } from '../../domain/provisioning/pod-security-facts.js'
import {
  findRegistries,
  isZotImage,
  kubeContextFor,
  skaffoldEnvFor,
  type RawIngress,
  type RawRegistryDeployment,
  type DiscoveredRegistry,
  type RawService,
  type RegistryFact
} from '../../domain/provisioning/registry-facts.js'
import type { DegradedRead, NamespaceFact, PolicySelector } from '../../domain/provisioning/types.js'
import type { KubernetesIdentity, KubernetesReader } from '../observability-kubernetes.js'
import type { AccessMatrixBuilder } from './access-matrix.js'
import { optional } from './tolerate.js'

// Per-namespace facts are deliberately NOT cached: quota headroom must be
// fresh, or a plan is green-lit that the apiserver has just started rejecting.
// It is five small GETs plus the access matrix, which caches itself.

const ns = (namespace: string) => encodeURIComponent(namespace)

type RawNamespace = { metadata?: { labels?: Record<string, string>; annotations?: Record<string, string> } }

export interface NamespaceFactsInput {
  namespace: string
  identity: KubernetesIdentity | null
  // The label an offering's own objects carry, e.g. "cnpg.io/cluster". Network
  // coverage is only meaningful relative to one offering.
  offeringLabelKey: string | null
  // The offering asked about, with every resource its sample creates, for the
  // create verdict. Null when none was asked about.
  target: ProvisionTarget | null
  // Every served offering, so the access profile can answer for all of them.
  targets: ProvisionTarget[]
  // The label an enforced guard scopes tenancy on, discovered from admission.
  tenantLabelKey: string | null
  admissionFacts: AdmissionPolicyFact[]
  // The cluster's identity, for the namespace-qualified kube context a
  // registry's skaffold.env names. Null renders a <cluster> placeholder.
  clusterId: string | null
}

export interface NamespaceFactsResult {
  fact: NamespaceFact
  labels: Record<string, string>
  // The namespace's own annotations, for facts a guard reads from them.
  annotations: Record<string, string>
  degraded: DegradedRead[]
}

export interface NamespaceFactsDependencies {
  read: KubernetesReader
  matrix: AccessMatrixBuilder
}

export async function loadNamespaceFacts(
  dependencies: NamespaceFactsDependencies,
  input: NamespaceFactsInput
): Promise<NamespaceFactsResult> {
  const { read } = dependencies
  const { namespace } = input
  const degraded: DegradedRead[] = []

  const record = <T>(source: string, result: Awaited<ReturnType<typeof optional<T>>>, fallback: T): T => {
    if (result.known) return result.value

    // "absent" is not a misconfiguration: a cluster without Cilium simply has
    // no such CRD. Only an RBAC refusal is worth surfacing as degraded.
    if (result.reason === 'rbac') degraded.push({ source, status: 403, message: result.detail })

    return fallback
  }

  const items = <T>(path: string): Promise<{ items?: T[] }> =>
    read(path).then(body => JSON.parse(body) as { items?: T[] })

  const [quotas, limits, native, cilium, namespaceMeta, matrix, registries] = await Promise.all([
    optional('resourcequotas', () =>
      items<RawResourceQuota>(`/api/v1/namespaces/${ns(namespace)}/resourcequotas`)
    ),
    optional('limitranges', () => items<RawLimitRange>(`/api/v1/namespaces/${ns(namespace)}/limitranges`)),
    optional('networkpolicies', () =>
      items<RawNetworkPolicy>(`/apis/networking.k8s.io/v1/namespaces/${ns(namespace)}/networkpolicies`)
    ),
    optional('ciliumnetworkpolicies', () =>
      items<RawCiliumPolicy>(`/apis/cilium.io/v2/namespaces/${ns(namespace)}/ciliumnetworkpolicies`)
    ),
    optional(
      'namespaces',
      async () => JSON.parse(await read(`/api/v1/namespaces/${ns(namespace)}`)) as RawNamespace
    ),
    input.identity ? dependencies.matrix.build(input.identity, namespace) : Promise.resolve(null),
    loadRegistries(read, namespace, degraded)
  ])

  const quotaItems = record('resourcequotas', quotas, { items: [] }).items ?? []
  const limitItems = record('limitranges', limits, { items: [] }).items ?? []
  const nativePolicies = record('networkpolicies', native, { items: [] }).items ?? []
  const ciliumPolicies = record('ciliumnetworkpolicies', cilium, { items: [] }).items ?? []
  const meta = record('namespaces', namespaceMeta, {} as RawNamespace)
  const labels = meta.metadata?.labels ?? {}

  // Several quotas can apply at once; the first is enough for headroom prose.
  const quota = quotaItems[0] ?? null

  const selectors: PolicySelector[] = input.offeringLabelKey
    ? extractSelectors(input.offeringLabelKey, nativePolicies, ciliumPolicies)
    : []

  const tenantId = input.tenantLabelKey ? (labels[input.tenantLabelKey] ?? null) : null
  const access = matrix ? summariseMatrix(matrix, input.targets) : null
  // RBAC across every resource the offering creates, then any enforced
  // admission policy governing its primary kind, which outranks RBAC.
  const verdictFor = (target: ProvisionTarget | null) => {
    const primary = target?.resources[0]
    const what = primary?.resource
      ? `${primary.resource}.${primary.group}`
      : target
        ? `the ${target.id} resource`
        : 'this'
    const { denials, constraints } =
      target && primary?.resource
        ? admissionFor(input.admissionFacts, {
            group: primary.group,
            resource: primary.resource,
            operation: 'CREATE',
            namespaceLabels: labels,
            callerGroups: input.identity?.groups
          })
        : { denials: [], constraints: [] }

    return mayCreateVerdict(access, target, denials, what, constraints)
  }

  const permission = verdictFor(input.target)
  const offerings: NamespaceFact['offerings'] = Object.fromEntries(
    input.targets.map(target => [target.id, verdictFor(target)])
  )

  if (
    access &&
    access.summary.unknown > 0 &&
    !degraded.some(entry => entry.source === 'subjectaccessreviews')
  ) {
    degraded.push({
      source: 'subjectaccessreviews',
      status: 0,
      message: `${access.summary.unknown} access review(s) for ${namespace} could not be evaluated; those cells are unknown, not denied.`
    })
  }

  return {
    fact: {
      namespace,
      tenant: input.tenantLabelKey && tenantId ? { labelKey: input.tenantLabelKey, id: tenantId } : null,
      sandbox: tenantId,
      quota: quota
        ? {
            name: quota.metadata?.name ?? '(unnamed)',
            used: quota.status?.used ?? {},
            hard: quota.status?.hard ?? quota.spec?.hard ?? {}
          }
        : null,
      headroom: computeHeadroom(quota),
      limitRange: containerDefaults(limitItems),
      network: {
        ingress: native.known ? detectPosture(nativePolicies, 'Ingress') : 'unknown',
        egress: native.known ? detectPosture(nativePolicies, 'Egress') : 'unknown',
        selectors,
        ciliumAvailable: cilium.known
      },
      access,
      mayCreate: permission.verdict,
      mayCreateReason: permission.reason,
      offerings,
      registries: registries.map((registry): RegistryFact => ({
        ...registry,
        skaffoldEnv: skaffoldEnvFor({
          context: kubeContextFor(input.clusterId, namespace),
          registryHost: registry.host,
          namespace
        })
      })),
      podSecurity: podSecurityFor(labels)
    },
    labels,
    annotations: meta.metadata?.annotations ?? {},
    degraded
  }
}

// Services and Ingresses are read only once a Deployment here runs Zot, so a
// namespace without a registry costs one listing, and a cluster that grants
// no Ingress reads loses only this fact. A refusal is reported like any other.
async function loadRegistries(
  read: KubernetesReader,
  namespace: string,
  degraded: DegradedRead[]
): Promise<DiscoveredRegistry[]> {
  const items = async <T>(path: string): Promise<T[]> =>
    (JSON.parse(await read(path)) as { items?: T[] }).items ?? []
  const note = (source: string, fact: { known: boolean; reason?: string; detail?: string }) => {
    if (!fact.known && fact.reason === 'rbac' && fact.detail)
      degraded.push({ source, status: 403, message: fact.detail })
  }

  const deployments = await optional('deployments', () =>
    items<RawRegistryDeployment>(`/apis/apps/v1/namespaces/${ns(namespace)}/deployments`)
  )

  note('deployments', deployments)

  const zot = deployments.known
    ? deployments.value.filter(deployment =>
        (deployment.spec?.template?.spec?.containers ?? []).some(c => c.image && isZotImage(c.image))
      )
    : []

  if (zot.length === 0) return []

  const [services, ingresses] = await Promise.all([
    optional('services', () => items<RawService>(`/api/v1/namespaces/${ns(namespace)}/services`)),
    optional('ingresses', () =>
      items<RawIngress>(`/apis/networking.k8s.io/v1/namespaces/${ns(namespace)}/ingresses`)
    )
  ])

  note('services', services)
  note('ingresses', ingresses)

  return services.known && ingresses.known ? findRegistries(zot, services.value, ingresses.value) : []
}
