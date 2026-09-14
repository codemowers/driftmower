import { describe, expect, it } from 'vitest'
import { BackendRequestError, DriftmowerBackendClient, buildQueryString } from './client.js'

interface StubCall {
  url: string
  headers: Headers
}

function createClient(handle: (call: StubCall, index: number) => Response) {
  const calls: StubCall[] = []
  const client = new DriftmowerBackendClient({
    baseUrl: 'http://driftmower-be.test/',
    serviceToken: 'dm_svc_token',
    fetchImplementation: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), headers: new Headers(init?.headers) }

      calls.push(call)

      return handle(call, calls.length - 1)
    }) as typeof fetch
  })

  return { client, calls }
}

function page(data: unknown[], total: number): Response {
  return new Response(JSON.stringify({ total, limit: 100, skip: 0, data }), { status: 200 })
}

describe('buildQueryString', () => {
  it('encodes nested filters the way the backend parses them', () => {
    const encoded = decodeURIComponent(
      buildQueryString({
        sourceType: 'cluster',
        $select: ['id', 'status'],
        $sort: { createdAt: -1 },
        $limit: 100
      })
    )

    expect(encoded).toBe('?sourceType=cluster&$select[0]=id&$select[1]=status&$sort[createdAt]=-1&$limit=100')
  })

  it('drops undefined values so optional filters need no branching', () => {
    expect(buildQueryString({ clusterContext: undefined, status: 'ready' })).toBe('?status=ready')
  })

  it('returns an empty string for an empty query', () => {
    expect(buildQueryString({})).toBe('')
  })
})

describe('DriftmowerBackendClient', () => {
  it('sends the service token and joins the path onto the base URL', async () => {
    const { client, calls } = createClient(() => page([], 0))

    await client.findPage('reports', { status: 'ready' })

    // The trailing slash on the base URL must not produce a doubled separator.
    expect(calls[0].url).toBe('http://driftmower-be.test/reports?status=ready')
    expect(calls[0].headers.get('authorization')).toBe('Bearer dm_svc_token')
  })

  it('pages until every row is read', async () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({ id: `row-${index}` }))
    const { client, calls } = createClient(call => {
      const skip = Number(new URL(call.url).searchParams.get('$skip'))

      return page(rows.slice(skip, skip + 100), rows.length)
    })

    const result = await client.findAll<{ id: string }>('image-usages', { reportId: 'report-1' })

    expect(result).toHaveLength(250)
    expect(calls).toHaveLength(3)
    expect(calls.map(call => new URL(call.url).searchParams.get('$skip'))).toEqual(['0', '100', '200'])
  })

  it('stops paging on an empty page even when the reported total is higher', async () => {
    const { client, calls } = createClient(() => page([], 500))

    await expect(client.findAll('image-usages', {})).resolves.toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('normalises an unpaginated array response', async () => {
    const { client } = createClient(() => new Response(JSON.stringify([{ id: 'a' }]), { status: 200 }))

    await expect(client.findPage('reports')).resolves.toMatchObject({ total: 1, data: [{ id: 'a' }] })
  })

  it('reports the status and body of a failed request', async () => {
    const { client } = createClient(
      () => new Response('{"name":"NotAuthenticated"}', { status: 401 })
    )

    const error = await client.findPage('reports').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(BackendRequestError)
    expect((error as BackendRequestError).status).toBe(401)
    expect((error as Error).message).toContain('NotAuthenticated')
  })

  it('reports a transport failure without leaking the underlying error type', async () => {
    const { client } = createClient(() => {
      throw new TypeError('fetch failed')
    })

    await expect(client.findPage('reports')).rejects.toThrow(/failed: fetch failed/)
  })

  it('rejects a response that is not a paginated envelope', async () => {
    const { client } = createClient(() => new Response('{"unexpected":true}', { status: 200 }))

    await expect(client.findPage('reports')).rejects.toThrow(/Unexpected response shape/)
  })
})
