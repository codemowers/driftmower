import { describe, expect, it, vi } from 'vitest'
import { CAPABILITIES_PATH, createDriftmowerUiClient } from './driftmower-ui.js'

const BASE_URL = 'http://driftmower-ui'

function clientWith(fetchImplementation: typeof fetch) {
  return createDriftmowerUiClient({ baseUrl: `${BASE_URL}/`, requestTimeoutMs: 1000, fetchImplementation })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('createDriftmowerUiClient', () => {
  it('forwards the caller bearer token and builds the query', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(jsonResponse({ inCluster: true }))
    const client = clientWith(fetchImplementation as unknown as typeof fetch)

    await client.fetchCapabilities('caller-token', {
      namespaces: ['sandbox-foo', 'sandbox-bar'],
      offering: 'postgres'
    })

    const [url, init] = fetchImplementation.mock.calls[0] as [URL, RequestInit]

    expect(url.pathname).toBe(CAPABILITIES_PATH)
    expect(url.searchParams.get('ns')).toBe('sandbox-foo,sandbox-bar')
    expect(url.searchParams.get('offering')).toBe('postgres')
    // The caller's own token, not a service credential: driftmower-ui decides
    // tenancy against the same identity this server verified.
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer caller-token')
  })

  it('omits the Authorization header when there is no caller token', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(jsonResponse({ inCluster: true }))

    await clientWith(fetchImplementation as unknown as typeof fetch).fetchCapabilities(null)

    const [, init] = fetchImplementation.mock.calls[0] as [URL, RequestInit]

    expect(init.headers).not.toHaveProperty('authorization')
  })

  it('reports a refused token distinctly from an outage', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 401))

    const result = await clientWith(fetchImplementation as unknown as typeof fetch).fetchCapabilities('t')

    expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
  })

  it('reports a transport failure as unreachable with the cause named', async () => {
    const fetchImplementation = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'))

    const result = await clientWith(fetchImplementation as unknown as typeof fetch).fetchCapabilities('t')

    expect(result).toMatchObject({ ok: false, reason: 'unreachable' })

    if (result.ok) return

    expect(result.detail).toContain('connect ECONNREFUSED')
    expect(result.detail).toContain(BASE_URL)
  })

  it('reports a non-JSON body as a bad response rather than throwing', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValue(new Response('<html>gateway</html>', { status: 200 }))

    const result = await clientWith(fetchImplementation as unknown as typeof fetch).fetchCapabilities('t')

    expect(result).toMatchObject({ ok: false, reason: 'bad_response' })
  })

  it('reports an unexpected status code', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(jsonResponse({}, 503))

    const result = await clientWith(fetchImplementation as unknown as typeof fetch).fetchCapabilities('t')

    expect(result).toMatchObject({ ok: false, reason: 'bad_response' })
  })
})
