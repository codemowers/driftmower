import type { Fact, PolicyFact } from '../../domain/provisioning/types.js'
import { collect } from '../kubernetes-list.js'
import type { KubernetesReader } from '../observability-kubernetes.js'
import { optional } from './tolerate.js'

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

export function toPolicyFact(raw: RawKyvernoPolicy): PolicyFact | null {
  const name = raw.metadata?.name

  if (!name) return null

  // Only Enforce can reject an apply; Audit merely reports.
  const mode = raw.spec?.validationFailureAction === 'Enforce' ? 'Enforce' : 'Audit'
  const touches = (raw.spec?.rules ?? []).flatMap(kindsOf)

  return {
    engine: 'kyverno',
    name,
    mode,
    touches: [...new Set(touches)],
    meaning:
      mode === 'Enforce'
        ? 'This policy can reject the apply. A server-side dry run is what tells you for certain.'
        : 'This policy only reports; it will not block the apply.'
  }
}

// A cluster without Kyverno simply has no such API; that is a fact, not a
// failure, and the tolerance layer reports it as absent.
export function loadKyvernoPolicies(read: KubernetesReader): Promise<Fact<PolicyFact[]>> {
  return optional('kyverno clusterpolicies', async () =>
    (
      await collect(read, '/apis/kyverno.io/v1/clusterpolicies', item =>
        toPolicyFact(item as RawKyvernoPolicy)
      )
    )
      .filter((policy): policy is PolicyFact => policy !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
  )
}
