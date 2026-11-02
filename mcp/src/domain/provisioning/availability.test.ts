import { expect, it } from 'vitest'

import { availabilityOf, isOfferable, type OperatorHealth } from './availability.js'

const healthy: OperatorHealth = {
  deployment: 'cnpg-cloudnative-pg',
  namespace: 'cnpg-system',
  readyReplicas: 1,
  desiredReplicas: 1,
  version: '1.24.1',
  watchedNamespaces: 'all'
}

it('no CRD means not installed, and the card links somewhere useful', () => {
  const availability = availabilityOf(false, null, 'https://cloudnative-pg.io/')

  expect(availability.state).toBe('not-installed')
  expect(availability.state === 'not-installed' && availability.installHref).toBe(
    'https://cloudnative-pg.io/'
  )
})

it('a missing controller is reported, because that failure is silent', () => {
  const availability = availabilityOf(true, null, null)

  expect(availability.state).toBe('crds-only')
  // The user must learn that the apply will appear to work.
  expect(availability.state === 'crds-only' ? availability.reason : '').toMatch(/would succeed/)
})

it('zero ready replicas is degraded, and names the deployment', () => {
  const availability = availabilityOf(true, { ...healthy, readyReplicas: 0 }, null)

  expect(availability.state).toBe('degraded')
  expect(availability.state === 'degraded' ? availability.reason : '').toMatch(
    /cnpg-system\/cnpg-cloudnative-pg/
  )
  expect(availability.state === 'degraded' ? availability.reason : '').toMatch(/0\/1 pods ready/)
})

it('a running controller is ready and carries its version', () => {
  const availability = availabilityOf(true, healthy, null)

  expect(availability.state).toBe('ready')
  expect(availability.state === 'ready' && availability.version).toBe('1.24.1')
})

it('only ready and degraded can be planned against', () => {
  expect(isOfferable(availabilityOf(true, healthy, null))).toBe(true)
  // Degraded is offerable on purpose: the manifest is still correct, and the
  // user may well be about to fix the operator.
  expect(isOfferable(availabilityOf(true, { ...healthy, readyReplicas: 0 }, null))).toBe(true)
  expect(isOfferable(availabilityOf(true, null, null))).toBe(false)
  expect(isOfferable(availabilityOf(false, null, null))).toBe(false)
})
