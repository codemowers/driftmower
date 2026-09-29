import {
  toAdmissionFacts,
  type AdmissionPolicyFact,
  type RawAdmissionBinding,
  type RawAdmissionPolicy
} from '../../domain/provisioning/admission-facts.js'
import { suffixFromParams, type DomainSuffix } from '../../domain/provisioning/ingress-facts.js'
import type { DegradedRead, Fact } from '../../domain/provisioning/types.js'
import type { ClusterCatalog } from '../cluster-catalog.js'
import type { KubernetesReader } from '../observability-kubernetes.js'
import { optional } from './tolerate.js'

// The policy catalog this server already reads (every served version of the
// admission APIs, with bindings joined) is the source; only the projection to
// the pure fact module's raw shape happens here.
export function loadAdmissionFacts(catalog: ClusterCatalog): Promise<Fact<AdmissionPolicyFact[]>> {
  return optional('validatingadmissionpolicies', async () => {
    const { policies } = await catalog.listAdmissionPolicies()
    const validating = policies.filter(policy => policy.kind === 'ValidatingAdmissionPolicy')
    const rawPolicies: RawAdmissionPolicy[] = validating.map(policy => ({
      metadata: { name: policy.name, annotations: policy.annotations },
      spec: policy.spec as RawAdmissionPolicy['spec']
    }))
    const rawBindings: RawAdmissionBinding[] = validating.flatMap(policy =>
      (policy.bindings ?? []).map(binding => ({
        metadata: { name: binding.name },
        spec: binding.spec as RawAdmissionBinding['spec']
      }))
    )

    return toAdmissionFacts(rawPolicies, rawBindings)
  })
}

type RawConfigMap = { data?: Record<string, string> }

export interface IngressSuffixResult {
  suffix: DomainSuffix | null
  degraded: DegradedRead[]
}

// A parameterised ingress guard names the ConfigMap holding its parameters,
// and for such a guard that parameter IS the answer to "what hostname may I
// use". It is read only where the binding says it lives; nothing is guessed.
// A configured suffix is the fallback, and its provenance is reported.
export async function loadIngressSuffix(
  read: KubernetesReader,
  facts: AdmissionPolicyFact[],
  configured: string | null
): Promise<IngressSuffixResult> {
  const guard = facts.find(
    fact =>
      fact.enforced &&
      fact.paramRef !== null &&
      fact.paramRef.namespace !== null &&
      fact.guards.some(g => g.resource === 'ingresses')
  )
  const degraded: DegradedRead[] = []

  if (guard?.paramRef?.namespace) {
    const { name, namespace } = guard.paramRef
    const configMap = await optional(
      'configmaps',
      async () =>
        JSON.parse(
          await read(
            `/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps/${encodeURIComponent(name)}`
          )
        ) as RawConfigMap
    )

    if (configMap.known) {
      const value = suffixFromParams(configMap.value.data)

      if (value) return { suffix: { value, source: 'guard-params' }, degraded }
    } else if (configMap.reason === 'rbac') {
      degraded.push({ source: 'configmaps', status: 403, message: configMap.detail })
    }
  }

  return { suffix: configured ? { value: configured, source: 'config' } : null, degraded }
}
