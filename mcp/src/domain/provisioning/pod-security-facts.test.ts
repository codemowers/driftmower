import { expect, it } from 'vitest'

import { podSecurityFor } from './pod-security-facts.js'

it('a restricted namespace reports the four fields the apiserver demands', () => {
  // Quoted from a live denial: a plain container in an enforce=restricted
  // sandbox is rejected for exactly these four.
  const fact = podSecurityFor({ 'pod-security.kubernetes.io/enforce': 'restricted' })

  expect(fact?.enforce).toBe('restricted')
  expect(fact?.requires).toEqual([
    'securityContext.runAsNonRoot=true',
    'securityContext.allowPrivilegeEscalation=false',
    'securityContext.capabilities.drop=["ALL"]',
    'securityContext.seccompProfile.type="RuntimeDefault"'
  ])
  expect(fact?.summary ?? '').toMatch(/cannot run as root/)
})

it('baseline allows root, and says so rather than implying otherwise', () => {
  const fact = podSecurityFor({ 'pod-security.kubernetes.io/enforce': 'baseline' })

  expect(fact?.enforce).toBe('baseline')
  expect(fact?.requires).toEqual([])
  expect(fact?.summary ?? '').toMatch(/running as root is allowed/)
})

it('privileged enforces nothing', () => {
  const fact = podSecurityFor({ 'pod-security.kubernetes.io/enforce': 'privileged' })

  expect(fact?.enforce).toBe('privileged')
  expect(fact?.summary ?? '').toMatch(/No pod security level/)
})

it('an unlabelled namespace reports nothing rather than guessing a level', () => {
  expect(podSecurityFor(undefined)).toBe(null)
  expect(podSecurityFor({})).toBe(null)
  expect(podSecurityFor({ 'pod-security.kubernetes.io/enforce': '' })).toBe(null)
  // An unrecognised value must not be reported as if it were understood.
  expect(podSecurityFor({ 'pod-security.kubernetes.io/enforce': 'weird' })).toBe(null)
})

it('the warn and audit labels are ignored: only enforce blocks', () => {
  const fact = podSecurityFor({ 'pod-security.kubernetes.io/warn': 'restricted' })

  expect(fact).toBe(null)
})
