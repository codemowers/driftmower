import { describe, expect, it } from 'vitest'
import { fakeReader, list } from '../../../test/fake-kubernetes-reader.js'
import { loadOperatorDeployments, operatorHealthLookup } from './operators.js'

const deployment = (name: string, namespace: string, extra: object = {}) => ({
  metadata: { name, namespace, labels: {} },
  spec: { replicas: 1, template: { spec: { containers: [{ image: 'ghcr.io/x/y:1.2.3' }] } } },
  status: { readyReplicas: 1 },
  ...extra
})

describe('operator health', () => {
  it('matches a controller in any namespace by name, prefix or labels', () => {
    const lookup = operatorHealthLookup([
      deployment('cnpg-cloudnative-pg', 'operators'),
      deployment('whatever', 'elsewhere', {
        metadata: {
          name: 'whatever',
          namespace: 'elsewhere',
          labels: { 'app.kubernetes.io/name': 'dragonfly-operator' }
        }
      }),
      deployment('cnpg-lookalike-tool', 'tools')
    ])

    expect(lookup({ deployment: 'cnpg' })).toMatchObject({
      deployment: 'cnpg-cloudnative-pg',
      namespace: 'operators',
      version: '1.2.3'
    })
    expect(
      lookup({ deployment: 'dragonfly-operator', labels: { 'app.kubernetes.io/name': 'dragonfly-operator' } })
    ).toMatchObject({
      deployment: 'whatever',
      namespace: 'elsewhere'
    })
    expect(lookup({ deployment: 'mongodb-kubernetes-operator' })).toBe(null)
  })

  it('reads the version label, and the watched namespaces from the controller args', () => {
    const lookup = operatorHealthLookup([
      {
        metadata: {
          name: 'rabbitmq-cluster-operator',
          namespace: 'rabbitmq-system',
          labels: { 'app.kubernetes.io/version': '2.9.0' }
        },
        spec: {
          replicas: 2,
          template: { spec: { containers: [{ image: 'x:y', args: ['--watch-namespaces=a,b'] }] } }
        },
        status: { readyReplicas: 0 }
      }
    ])

    expect(lookup({ deployment: 'rabbitmq-cluster-operator' })).toEqual({
      deployment: 'rabbitmq-cluster-operator',
      namespace: 'rabbitmq-system',
      readyReplicas: 0,
      desiredReplicas: 2,
      version: '2.9.0',
      watchedNamespaces: ['a', 'b']
    })
  })

  it('lists deployments in pages and degrades a refused read', async () => {
    const { read, calls } = fakeReader({ '/apis/apps/v1/deployments': list([deployment('a', 'b')]) })

    expect(await loadOperatorDeployments(read)).toMatchObject({
      known: true,
      value: [expect.objectContaining({ metadata: expect.anything() })]
    })
    expect(calls[0].path).toBe('/apis/apps/v1/deployments?limit=200')
    expect(
      await loadOperatorDeployments(fakeReader({ '/apis/apps/v1/deployments': 403 }).read)
    ).toMatchObject({ known: false, reason: 'rbac' })
  })
})
