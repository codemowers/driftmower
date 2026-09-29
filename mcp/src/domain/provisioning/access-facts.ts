// PURE. The per-namespace access matrix and everything derived from it.
//
// Every cell is the cluster authorizer's own answer to one SubjectAccessReview
// (identity, namespace, resource, verb). Nothing here reads a Role or a
// RoleBinding, so there is no logic that can be wrong about aggregation,
// wildcards, custom role names or webhook authorizers. The only judgement is
// in the folds below, and each of them is a lookup.

import type { Denial } from './admission-facts.js'
import type { AccessProfile, OfferingId } from './types.js'

export type Verdict = 'yes' | 'no' | 'unknown'

export const VERBS = [
  'get',
  'list',
  'watch',
  'create',
  'update',
  'patch',
  'delete',
  'deletecollection'
] as const

export type Verb = (typeof VERBS)[number]

export type AccessMatrix = AccessProfile['matrix']

export interface Judgement {
  verdict: Verdict
  reason: string | null
}

// "group/resource"; the core group is the empty string, so pods are "/pods".
export function resourceKey(group: string, resource: string): string {
  return `${group}/${resource}`
}

export interface ProvisionTarget {
  id: OfferingId
  // Every resource the offering's sample manifest creates. `null` for the
  // primary kind when the cluster does not serve it.
  resources: { group: string; resource: string | null; reason?: string }[]
}

const VIEW = resourceKey('', 'pods')
const EDIT = resourceKey('apps', 'deployments')
const ADMIN = resourceKey('rbac.authorization.k8s.io', 'rolebindings')

function cell(matrix: AccessMatrix, key: string, verb: Verb): Verdict {
  return matrix[key]?.[verb] ?? 'unknown'
}

export function summariseMatrix(matrix: AccessMatrix, targets: ProvisionTarget[]): AccessProfile {
  const byVerb = Object.fromEntries(VERBS.map(verb => [verb, 0])) as Record<Verb, number>
  let unknown = 0

  for (const verdicts of Object.values(matrix)) {
    for (const verb of VERBS) {
      if (verdicts[verb] === 'yes') byVerb[verb] += 1
      else if (verdicts[verb] === 'unknown') unknown += 1
    }
  }

  const provision: AccessProfile['provision'] = {}
  const provisionDetail: AccessProfile['provisionDetail'] = {}

  for (const target of targets) {
    const rows = target.resources.map(entry => {
      if (entry.resource === null) {
        return {
          resource: `?.${entry.group}`,
          verdict: 'unknown' as const,
          reason:
            entry.reason ?? `The cluster does not serve this ${entry.group} resource, so its name is unknown`
        }
      }

      const key = resourceKey(entry.group, entry.resource)
      const verdict = cell(matrix, key, 'create')

      return {
        resource: `${entry.resource}.${entry.group || 'core'}`,
        verdict,
        reason:
          verdict === 'yes'
            ? null
            : verdict === 'no'
              ? `Kubernetes RBAC denies create ${entry.resource}.${entry.group || 'core'}`
              : 'The access review for this resource could not be evaluated'
      }
    })

    provisionDetail[target.id] = rows
    provision[target.id] = rows.every(row => row.verdict === 'yes')
      ? 'yes'
      : rows.some(row => row.verdict === 'unknown')
        ? 'unknown'
        : 'no'
  }

  return {
    matrix,
    view: cell(matrix, VIEW, 'list'),
    edit: cell(matrix, EDIT, 'create'),
    admin: cell(matrix, ADMIN, 'create'),
    provision,
    provisionDetail,
    summary: { resourceTypes: Object.keys(matrix).length, byVerb, unknown }
  }
}

// Admission denials are checked FIRST and on purpose. A policy can reject what
// RBAC allows, and RBAC-only is the optimistic direction: the one that wastes
// a beginner's afternoon.
export function composeCreateVerdict(
  rbac: Judgement,
  denials: Denial[],
  what: string
): { verdict: Verdict; reason: string } {
  if (denials.length > 0) {
    const denial = denials[0]
    // Every message, because a policy often carries a specific rule and a
    // blanket one and only the blanket one explains a beginner's failure.
    const said = denial.messages.map(message => message.replace(/\.$/, '')).join('. ')

    return {
      verdict: 'no',
      reason:
        `An enforced admission policy (${denial.policy}) governs creating ${what}: ${said}. ` +
        'An admission policy overrides your role, so having permission is not enough here; this needs someone with platform access.'
    }
  }

  switch (rbac.verdict) {
    case 'yes':
      return {
        verdict: 'yes',
        reason: `Kubernetes RBAC allows creating ${what}, and no enforced admission policy governs it.`
      }
    case 'no':
      return { verdict: 'no', reason: rbac.reason ?? `Kubernetes RBAC denies creating ${what}.` }
    default:
      return {
        verdict: 'unknown',
        reason: `${rbac.reason ?? 'The access review could not be evaluated'}. Run \`kubectl auth can-i create ${what}\` to check.`
      }
  }
}

// The verdict for an offering in a namespace: every resource its sample would
// create, folded, with admission on top of the primary kind.
export function mayCreateVerdict(
  profile: AccessProfile | null,
  target: ProvisionTarget | null,
  denials: Denial[],
  what: string
): { verdict: Verdict; reason: string } {
  if (!target) return { verdict: 'unknown', reason: 'No offering selected yet, so nothing has been checked.' }

  if (!profile) {
    return {
      verdict: 'unknown',
      reason: `The call carried no verified caller, so permission was not checked. Run \`kubectl auth can-i create ${what}\` to check.`
    }
  }

  const rows = profile.provisionDetail[target.id] ?? []
  const blocking = rows.filter(row => row.verdict === 'no')
  const uncertain = rows.filter(row => row.verdict === 'unknown')
  const rbac: Judgement =
    blocking.length > 0
      ? {
          verdict: 'no',
          reason: `Kubernetes RBAC denies create on ${blocking.map(row => row.resource).join(', ')}`
        }
      : uncertain.length > 0
        ? {
            verdict: 'unknown',
            reason: `The access review for ${uncertain.map(row => row.resource).join(', ')} could not be evaluated`
          }
        : { verdict: 'yes', reason: null }

  return composeCreateVerdict(rbac, denials, what)
}
