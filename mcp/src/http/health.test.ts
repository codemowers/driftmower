import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startHealthServer } from './health.js'
import { closeHttpServer } from './shutdown.js'
import { ApplicationMetrics } from './metrics.js'

describe('health server', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server) await closeHttpServer(server)

    server = undefined
  })

  it('reports readiness only while the application can accept traffic', async () => {
    let ready = false
    const url = await start(() => ready)

    for (const path of ['/readyz', '/startupz']) {
      expect((await fetch(`${url}${path}`)).status).toBe(503)
    }

    expect((await fetch(`${url}/healthz`)).status).toBe(200)
    ready = true
    for (const path of ['/readyz', '/startupz']) {
      const response = await fetch(`${url}${path}`)

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: 'ok' })
    }

    ready = false
    expect((await fetch(`${url}/readyz`)).status).toBe(503)
  })

  it('exposes application metrics on the internal listener', async () => {
    const metrics = new ApplicationMetrics()
    const url = await start(() => true, metrics)

    metrics.sessions.inc()
    const response = await fetch(`${url}/metrics`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(await response.text()).toContain('driftmower_mcp_sessions_total 1')
  })

  it('rejects non-GET requests and unknown paths', async () => {
    const url = await start(() => true)

    expect((await fetch(`${url}/readyz`, { method: 'POST' })).status).toBe(405)
    expect((await fetch(`${url}/missing`)).status).toBe(404)
  })

  async function start(isReady: () => boolean, metrics?: ApplicationMetrics): Promise<string> {
    server = await startHealthServer({ host: '127.0.0.1', port: 0, isReady, metrics })

    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
})
