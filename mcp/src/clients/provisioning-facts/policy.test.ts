import { describe, expect, it } from 'vitest'
import { fakeReader, list } from '../../../test/fake-kubernetes-reader.js'
import { loadKyvernoPolicies, toPolicyFact } from './policy.js'

describe('kyverno policies', () => {
  it('flattens kinds from both match shapes and only Enforce can block', () => {
    expect(
      toPolicyFact({
        metadata: { name: 'require-labels' },
        spec: {
          validationFailureAction: 'Enforce',
          rules: [
            {
              match: { resources: { kinds: ['Pod'] }, any: [{ resources: { kinds: ['Deployment', 'Pod'] } }] }
            }
          ]
        }
      })
    ).toMatchObject({
      engine: 'kyverno',
      mode: 'Enforce',
      touches: ['Pod', 'Deployment'],
      meaning: expect.stringContaining('reject')
    })
    expect(
      toPolicyFact({ metadata: { name: 'audit' }, spec: { validationFailureAction: 'Audit' } })?.meaning
    ).toContain('only reports')
    expect(toPolicyFact({})).toBe(null)
  })

  it('reports an absent Kyverno as a fact, not a failure', async () => {
    expect(
      await loadKyvernoPolicies(fakeReader({ '/apis/kyverno.io/v1/clusterpolicies': 404 }).read)
    ).toMatchObject({ known: false, reason: 'absent' })
    expect(
      await loadKyvernoPolicies(
        fakeReader({
          '/apis/kyverno.io/v1/clusterpolicies': list([
            { metadata: { name: 'b' } },
            { metadata: { name: 'a' } }
          ])
        }).read
      )
    ).toMatchObject({ known: true, value: [{ name: 'a' }, { name: 'b' }] })
  })
})
