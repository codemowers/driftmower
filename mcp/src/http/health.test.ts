import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { DriftmowerBackendClient } from '../backend/client.js'
import { startHealthServer } from './health.js'

describe('health server', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close(error => (error ? reject(error) : resolve()))
      })
      server = undefined
    }
  })

  it('reports liveness even when the backend is unreachable', async () => {
    const baseUrl = await startServer(() => {
      throw new Error('connection refused')
    })

    const response = await fetch(`${baseUrl}/healthz`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('reports not ready when the backend is unreachable', async () => {
    const baseUrl = await startServer(() => {
      throw new Error('connection refused')
    })

    const response = await fetch(`${baseUrl}/readyz`)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      status: 'not_ready',
      checks: { backend: { ok: false } }
    })
  })

  it('reports not ready when the backend rejects the service token', async () => {
    const baseUrl = await startServer(
      () => new Response('{"name":"NotAuthenticated"}', { status: 401 })
    )

    const response = await fetch(`${baseUrl}/startupz`)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      status: 'not_ready',
      checks: { backend: { ok: false } }
    })
  })

  it('reports ready when the backend answers an authenticated read', async () => {
    const requestedUrls: string[] = []
    const baseUrl = await startServer(url => {
      requestedUrls.push(url)

      return new Response(JSON.stringify({ total: 0, limit: 1, skip: 0, data: [] }), { status: 200 })
    })

    const response = await fetch(`${baseUrl}/readyz`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      checks: { backend: { ok: true } }
    })
    // An empty report list still means ready: the probe answers whether the
    // backend is reachable and the credential works, not whether it holds data.
    expect(requestedUrls[0]).toContain('/reports?')
  })

  it('rejects non-GET requests', async () => {
    const baseUrl = await startServer(
      () => new Response(JSON.stringify({ total: 0, limit: 1, skip: 0, data: [] }), { status: 200 })
    )

    const response = await fetch(`${baseUrl}/readyz`, { method: 'POST' })

    expect(response.status).toBe(405)
  })

  async function startServer(handle: (url: string) => Response): Promise<string> {
    const client = new DriftmowerBackendClient({
      baseUrl: 'http://driftmower-be.test',
      serviceToken: 'dm_svc_token',
      fetchImplementation: (async input => handle(String(input))) as typeof fetch
    })

    server = await startHealthServer({ host: '127.0.0.1', port: 0, client })

    const address = server.address() as AddressInfo

    return `http://127.0.0.1:${address.port}`
  }
})
