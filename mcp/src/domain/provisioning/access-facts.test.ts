import { expect, it } from 'vitest'
import {
  composeCreateVerdict,
  mayCreateVerdict,
  resourceKey,
  summariseMatrix,
  VERBS,
  type AccessMatrix
} from './access-facts.js'

const all = (verdict: 'yes' | 'no' | 'unknown') =>
  Object.fromEntries(VERBS.map(verb => [verb, verdict])) as Record<(typeof VERBS)[number], typeof verdict>

const MATRIX: AccessMatrix = {
  [resourceKey('', 'pods')]: { ...all('yes'), delete: 'no' },
  [resourceKey('', 'secrets')]: all('yes'),
  [resourceKey('apps', 'deployments')]: all('yes'),
  [resourceKey('rbac.authorization.k8s.io', 'rolebindings')]: all('no'),
  [resourceKey('postgresql.cnpg.io', 'clusters')]: all('yes'),
  [resourceKey('rabbitmq.com', 'rabbitmqclusters')]: { ...all('yes'), create: 'no' },
  [resourceKey('s3.onyxia.sh', 'buckets')]: { ...all('no'), create: 'unknown' }
}

const TARGETS = [
  {
    id: 'postgres' as const,
    resources: [
      { group: 'postgresql.cnpg.io', resource: 'clusters' },
      { group: '', resource: 'secrets' }
    ]
  },
  { id: 'rabbitmq' as const, resources: [{ group: 'rabbitmq.com', resource: 'rabbitmqclusters' }] },
  {
    id: 'bucket' as const,
    resources: [
      { group: 's3.onyxia.sh', resource: 'buckets' },
      { group: 's3.onyxia.sh', resource: 's3users' }
    ]
  },
  { id: 'emqx' as const, resources: [{ group: 'apps.emqx.io', resource: null, reason: 'not served' }] }
]

it('derives view, edit and admin from fixed cells and counts per verb', () => {
  const profile = summariseMatrix(MATRIX, [])

  expect(profile.view).toBe('yes')
  expect(profile.edit).toBe('yes')
  expect(profile.admin).toBe('no')
  expect(profile.summary.resourceTypes).toBe(7)
  expect(profile.summary.byVerb.create).toBe(4)
  expect(profile.summary.byVerb.delete).toBe(4)
  expect(profile.summary.unknown).toBe(1)
})

it('an offering is creatable only when every resource its sample creates is', () => {
  const profile = summariseMatrix(MATRIX, TARGETS)

  expect(profile.provision).toEqual({ postgres: 'yes', rabbitmq: 'no', bucket: 'unknown', emqx: 'unknown' })
  expect(profile.provisionDetail.rabbitmq).toEqual([
    {
      resource: 'rabbitmqclusters.rabbitmq.com',
      verdict: 'no',
      reason: 'Kubernetes RBAC denies create rabbitmqclusters.rabbitmq.com'
    }
  ])
  // A resource missing from the matrix is unknown, never silently allowed.
  expect(profile.provisionDetail.bucket?.map(row => row.verdict)).toEqual(['unknown', 'unknown'])
  expect(profile.provisionDetail.emqx?.[0].reason).toBe('not served')
})

it('an enforced admission denial outranks an RBAC yes, and names the policy', () => {
  const verdict = composeCreateVerdict(
    { verdict: 'yes', reason: null },
    [{ policy: 'egress-guard', messages: ['No.', 'Really no'] }],
    'networkpolicies'
  )

  expect(verdict.verdict).toBe('no')
  expect(verdict.reason).toContain('egress-guard')
  expect(verdict.reason).toContain('No. Really no')
  expect(composeCreateVerdict({ verdict: 'yes', reason: null }, [], 'x').verdict).toBe('yes')
  expect(
    composeCreateVerdict({ verdict: 'unknown', reason: 'webhook down' }, [], 'clusters.postgresql.cnpg.io')
      .reason
  ).toContain('kubectl auth can-i create clusters.postgresql.cnpg.io')
})

it("folds an offering's rows and admission into one verdict, and is honest without a caller", () => {
  const profile = summariseMatrix(MATRIX, TARGETS)

  expect(mayCreateVerdict(profile, TARGETS[0], [], 'clusters.postgresql.cnpg.io').verdict).toBe('yes')
  expect(mayCreateVerdict(profile, TARGETS[1], [], 'rabbitmqclusters.rabbitmq.com')).toMatchObject({
    verdict: 'no',
    reason: expect.stringContaining('rabbitmqclusters.rabbitmq.com')
  })
  expect(mayCreateVerdict(profile, TARGETS[2], [], 'buckets.s3.onyxia.sh').verdict).toBe('unknown')
  expect(mayCreateVerdict(profile, TARGETS[0], [{ policy: 'guard', messages: ['nope'] }], 'x').verdict).toBe(
    'no'
  )
  expect(mayCreateVerdict(null, TARGETS[0], [], 'x')).toMatchObject({
    verdict: 'unknown',
    reason: expect.stringContaining('no verified caller')
  })
  expect(mayCreateVerdict(profile, null, [], 'x').verdict).toBe('unknown')
})

it('an offering the cluster does not serve is unknown for that reason, not for a failed review', () => {
  const profile = summariseMatrix(MATRIX, TARGETS)

  expect(mayCreateVerdict(profile, TARGETS[3], [], 'emqxes.apps.emqx.io')).toEqual({
    verdict: 'unknown',
    reason: 'not served'
  })
})
