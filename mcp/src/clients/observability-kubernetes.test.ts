import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createObservabilityKubernetes } from './observability-kubernetes.js'
import type { HttpRequester } from './observability-http.js'

describe('Kubernetes observability client', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'observability-'))
    await writeFile(join(directory, 'token'), 'service-token\n')
    await writeFile(join(directory, 'ca'), 'cluster-ca')
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  function setup(status = { allowed: true }) {
    const request = vi
      .fn<HttpRequester>()
      .mockResolvedValue({ status: 201, body: JSON.stringify({ status }) })
    const client = createObservabilityKubernetes({
      url: 'https://kubernetes.default.svc',
      tokenFile: join(directory, 'token'),
      caFile: join(directory, 'ca'),
      request
    })

    return { client, request }
  }

  it('reads only the default/kubelogin ingress with service-account credentials', async () => {
    const { client, request } = setup()
    const ingress = { spec: { rules: [{ host: 'kube.example.com' }] } }

    request.mockResolvedValue({ status: 200, body: JSON.stringify(ingress) })
    expect(await client.kubeloginIngress()).toEqual(ingress)
    expect(request.mock.calls[0][0].url.pathname).toBe(
      '/apis/networking.k8s.io/v1/namespaces/default/ingresses/kubelogin'
    )
    expect(request.mock.calls[0][0].headers?.authorization).toBe('Bearer service-token')
  })

  const identity = { user: 'issuer#alice', groups: ['devs', 'system:authenticated'] }
  const attributes = { namespace: 'a', group: '', resource: 'pods', verb: 'list' }

  it('reviews the caller, not the service account, and reloads rotated tokens', async () => {
    const { client, request } = setup()

    expect(await client.allowed(identity, attributes)).toBe(true)
    const call = request.mock.calls[0][0]

    expect(call.url.pathname).toBe('/apis/authorization.k8s.io/v1/subjectaccessreviews')
    expect(call.headers?.authorization).toBe('Bearer service-token')
    expect(call.ca).toBe('cluster-ca')
    expect(JSON.parse(call.body!)).toEqual({
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SubjectAccessReview',
      spec: { ...identity, resourceAttributes: attributes }
    })
    await writeFile(join(directory, 'token'), 'rotated')
    await client.allowed(identity, attributes)
    expect(request.mock.calls[1][0].headers?.authorization).toBe('Bearer rotated')
  })

  it.each([{ allowed: false }, { allowed: true, denied: true }])(
    'fails closed on review status %j',
    async status => {
      const { client, request } = setup()

      request.mockResolvedValue({ status: 201, body: JSON.stringify({ status }) })
      expect(await client.allowed(identity, attributes)).toBe(false)
    }
  )

  it.each([{}, { allowed: true, evaluationError: 'broken webhook' }])(
    'rejects inconclusive reviews %j',
    async status => {
      const { client, request } = setup()

      request.mockResolvedValue({ status: 201, body: JSON.stringify({ status }) })
      await expect(client.allowed(identity, attributes)).rejects.toThrow('inconclusive')
    }
  )

  it('rejects Kubernetes authentication/authorization errors', async () => {
    const { client, request } = setup()

    request.mockResolvedValue({ status: 403, body: 'sensitive upstream detail' })
    await expect(client.allowed(identity, attributes)).rejects.toThrow('Kubernetes API returned HTTP 403')
  })

  it('reads only the named namespace and pod log endpoint', async () => {
    const { client, request } = setup()

    request.mockResolvedValue({ status: 200, body: 'timestamp hello' })
    expect(await client.podLogs('team-a', 'api-1', new URLSearchParams({ container: 'app' }))).toBe(
      'timestamp hello'
    )
    expect(request.mock.calls[0][0].url.toString()).toBe(
      'https://kubernetes.default.svc/api/v1/namespaces/team-a/pods/api-1/log?container=app'
    )
  })
})
