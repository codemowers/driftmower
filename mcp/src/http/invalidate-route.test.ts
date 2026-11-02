import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpServer } from '../mcp/create-server.js'
import { startHttpTransport } from '../mcp/transports/http.js'
import { INVALIDATE_PATH, type InvalidateRouteDependencies } from './invalidate-route.js'

describe('POST /api/cache/invalidate', () => {
  let httpServer: Server | undefined

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve, reject) =>
        httpServer?.close(error => (error ? reject(error) : resolve()))
      )
      httpServer = undefined
    }
  })

  async function start(overrides: Partial<InvalidateRouteDependencies> = {}) {
    const dependencies: InvalidateRouteDependencies = {
      sharedToken: 'secret',
      allowedSubjects: ['system:serviceaccount:argocd:argocd-server'],
      tokenReview: vi.fn(async token => ({
        authenticated: token === 'sa-token',
        username: token === 'sa-token' ? 'system:serviceaccount:argocd:argocd-server' : null
      })),
      clearReviews: vi.fn(() => 42),
      invalidateNamespace: vi.fn(() => 3),
      invalidateIdentity: vi.fn(() => 1),
      invalidateFacts: vi.fn(),
      onInvalidate: vi.fn(),
      ...overrides
    }

    httpServer = await startHttpTransport(() => createMcpServer({}), {
      host: '127.0.0.1',
      port: 0,
      invalidate: dependencies
    })
    const { port } = httpServer.address() as AddressInfo

    return { base: `http://127.0.0.1:${port}`, dependencies }
  }

  const post = (base: string, token: string | null, body: unknown) =>
    fetch(`${base}${INVALIDATE_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    })

  it('clears everything for the shared secret and reports the count', async () => {
    const { base, dependencies } = await start()
    const response = await post(base, 'secret', { scope: 'all' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ cleared: 42, scope: 'all' })
    expect(dependencies.invalidateFacts).toHaveBeenCalled()
    expect(dependencies.onInvalidate).toHaveBeenCalledWith('webhook', 'all by shared-token', 42)
  })

  it('accepts a ServiceAccount token that TokenReview resolves to an allowed subject', async () => {
    const { base, dependencies } = await start()

    expect(await (await post(base, 'sa-token', { scope: 'namespace', namespace: 'team-a' })).json()).toEqual({
      cleared: 3,
      scope: 'namespace'
    })
    expect(dependencies.invalidateNamespace).toHaveBeenCalledWith('team-a')
    expect(dependencies.onInvalidate).toHaveBeenCalledWith(
      'webhook',
      'namespace=team-a by system:serviceaccount:argocd:argocd-server',
      3
    )
    expect((await post(base, 'other-token', { scope: 'all' })).status).toBe(403)
  })

  it('rejects a missing token, a bad scope, a bad body and other methods', async () => {
    const { base, dependencies } = await start()

    expect((await post(base, null, { scope: 'all' })).status).toBe(401)
    expect((await post(base, 'secret', { scope: 'everything' })).status).toBe(400)
    expect((await post(base, 'secret', { scope: 'namespace' })).status).toBe(400)
    expect((await post(base, 'secret', { scope: 'identity', sub: 'alice' })).status).toBe(200)
    expect(dependencies.invalidateIdentity).toHaveBeenCalledWith('alice')
    expect(
      (
        await fetch(`${base}${INVALIDATE_PATH}`, {
          method: 'POST',
          headers: { authorization: 'Bearer secret' },
          body: '{'
        })
      ).status
    ).toBe(400)
    expect((await fetch(`${base}${INVALIDATE_PATH}`)).status).toBe(405)
    expect(dependencies.clearReviews).not.toHaveBeenCalled()
  })

  it('is a 404 when no credential is configured for it', async () => {
    const { base } = await start({ sharedToken: null, allowedSubjects: [] })

    expect((await post(base, 'secret', { scope: 'all' })).status).toBe(404)
  })
})
