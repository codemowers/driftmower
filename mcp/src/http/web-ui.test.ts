import { afterEach, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { startHttpTransport } from '../mcp/transports/http.js'

let server: Server | undefined

afterEach(async () => {
  server?.closeAllConnections()
  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()))
})
async function start(enabled: boolean): Promise<string> {
  server = await startHttpTransport(() => new McpServer({ name: 'test', version: '1' }), {
    host: '127.0.0.1',
    port: 0,
    webUi: enabled
      ? { issuer: 'https://auth.example', clientId: 'public-explorer', resource: 'https://mcp.example/mcp' }
      : undefined
  })

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('toggleable web explorer', () => {
  it('omits the link and returns 404 for all UI routes when disabled', async () => {
    const base = await start(false)

    expect(await (await fetch(base)).text()).not.toContain('href="/ui"')
    for (const path of ['/ui', '/ui/config', '/ui/callback', '/ui/explorer.js']) {
      expect((await fetch(base + path)).status).toBe(404)
    }
  })
  it('serves the explorer, public config and popup callback without credentials', async () => {
    const base = await start(true)
    const response = await fetch(base + '/ui')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(response.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(response.headers.get('content-security-policy')).toContain(
      "connect-src 'self' https://auth.example"
    )
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.text()).toContain('Sign in with OpenID')
    expect(await (await fetch(base)).text()).toContain('href="/ui"')
    expect(await (await fetch(base + '/ui/config')).json()).toEqual({
      issuer: 'https://auth.example',
      clientId: 'public-explorer',
      resource: 'https://mcp.example/mcp'
    })
    expect((await fetch(base + '/ui/callback?code=not-stored')).status).toBe(200)
    expect(await (await fetch(base + '/ui', { method: 'HEAD' })).text()).toBe('')
    expect((await fetch(base + '/ui', { method: 'POST' })).status).toBe(405)
    expect((await fetch(base + '/ui/unknown')).status).toBe(404)
  })
})
