import { describe, expect, it } from 'vitest'
import { KubernetesApiError } from '../observability-kubernetes.js'
import { optional, valueOr } from './tolerate.js'

describe('optional', () => {
  it('degrades a refused read and an unserved API differently, and rethrows the rest', async () => {
    expect(await optional('nodes', async () => 1)).toEqual({ known: true, value: 1 })
    expect(await optional('nodes', () => Promise.reject(new KubernetesApiError(403)))).toMatchObject({
      known: false,
      reason: 'rbac',
      detail: expect.stringContaining('observability-rbac.yaml')
    })
    expect(
      await optional('ciliumnetworkpolicies', () => Promise.reject(new KubernetesApiError(404)))
    ).toMatchObject({
      known: false,
      reason: 'absent'
    })
    await expect(optional('nodes', () => Promise.reject(new KubernetesApiError(500)))).rejects.toThrow(
      'HTTP 500'
    )
    await expect(optional('nodes', () => Promise.reject(new Error('socket hang up')))).rejects.toThrow(
      'socket'
    )
    expect(valueOr({ known: false, reason: 'absent', detail: '' }, [])).toEqual([])
  })
})
