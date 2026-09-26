import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpServer } from '../create-server.js'
import { startHttpTransport } from './http.js'
import { UNRESTRICTED_SCOPE } from '../../domain/tenancy.js'

describe('HTTP MCP transport', () => {
  let httpServer: Server | undefined
  let clients: Client[] = []

  afterEach(async () => {
    await Promise.all(clients.map(client => client.close()))
    clients = []

    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer?.close(error => (error ? reject(error) : resolve()))
      })
    }
  })

  it('serves search_workloads on /mcp', async () => {
    const searchWorkloads = vi.fn().mockResolvedValue({
      query: 'api',
      matches: [],
      scope: { scoped: false, namespaces: null, note: null }
    })
    const planImageUpdates = vi.fn()
    const serverErrors: unknown[] = []

    httpServer = await startHttpTransport(
      () =>
        createMcpServer({
          workloadSearchService: { searchWorkloads },
          imageUpdatePlanningService: { planImageUpdates }
        }),
      {
        host: '127.0.0.1',
        port: 0,
        onError: error => serverErrors.push(error)
      }
    )
    const address = httpServer.address() as AddressInfo

    const client = new Client({ name: 'http-test-client', version: '1.0.0' })

    clients.push(client)
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`))

    await client.connect(transport).catch((error: unknown) => {
      const details =
        error instanceof Error
          ? { message: error.message, code: 'code' in error ? error.code : undefined }
          : { error }

      throw new Error(
        `HTTP MCP connection failed: ${JSON.stringify({
          details,
          serverErrors: serverErrors.map(serverError =>
            serverError instanceof Error ? serverError.message : String(serverError)
          )
        })}`
      )
    })
    const result = await client.callTool({
      name: 'search_workloads',
      arguments: { query: 'api' }
    })

    expect(result.structuredContent).toEqual({
      query: 'api',
      matches: [],
      scope: { scoped: false, namespaces: null, note: null }
    })
    expect(searchWorkloads).toHaveBeenCalledWith({
      query: 'api',
      limit: undefined,
      scope: UNRESTRICTED_SCOPE
    })
  })

  it('accepts a second client initialization as a separate HTTP session', async () => {
    const searchWorkloads = vi.fn().mockResolvedValue({
      query: 'llm',
      matches: [],
      scope: { scoped: false, namespaces: null, note: null }
    })
    const planImageUpdates = vi.fn()

    httpServer = await startHttpTransport(
      () =>
        createMcpServer({
          workloadSearchService: { searchWorkloads },
          imageUpdatePlanningService: { planImageUpdates }
        }),
      {
        host: '127.0.0.1',
        port: 0
      }
    )
    const address = httpServer.address() as AddressInfo
    const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`)
    const firstClient = new Client({ name: 'first-http-test-client', version: '1.0.0' })
    const secondClient = new Client({ name: 'second-http-test-client', version: '1.0.0' })

    clients.push(firstClient, secondClient)

    await firstClient.connect(new StreamableHTTPClientTransport(endpoint))
    await secondClient.connect(new StreamableHTTPClientTransport(endpoint))

    const result = await secondClient.callTool({
      name: 'search_workloads',
      arguments: { query: 'llm' }
    })

    expect(result.structuredContent).toEqual({
      query: 'llm',
      matches: [],
      scope: { scoped: false, namespaces: null, note: null }
    })
  })
  it('serves the landing page and connection instructions at /', async () => {
    httpServer = await startHttpTransport(
      () =>
        createMcpServer({
          workloadSearchService: { searchWorkloads: vi.fn() },
          imageUpdatePlanningService: { planImageUpdates: vi.fn() }
        }),
      {
        host: '127.0.0.1',
        port: 0
      }
    )
    const address = httpServer.address() as AddressInfo

    const response = await fetch(`http://127.0.0.1:${address.port}/`, { redirect: 'manual' })

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const html = await response.text()

    expect(html).toContain('Zen of Kubernetes')
    expect(html).toContain('claude mcp add --transport http --scope user')
    expect(html).toContain(`codex mcp add driftmower-127-0-0-1-${address.port} --url`)
    expect(html).toContain(`http://127.0.0.1:${address.port}/mcp`)
    expect(html).toContain('/mcp')
    expect(html).not.toContain('class="path"')

    const head = await fetch(`http://127.0.0.1:${address.port}/`, { method: 'HEAD' })

    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(response.headers.get('content-length'))
    expect(await head.text()).toBe('')
  })

  it('keeps unknown paths a 404', async () => {
    httpServer = await startHttpTransport(
      () =>
        createMcpServer({
          workloadSearchService: { searchWorkloads: vi.fn() },
          imageUpdatePlanningService: { planImageUpdates: vi.fn() }
        }),
      {
        host: '127.0.0.1',
        port: 0
      }
    )
    const address = httpServer.address() as AddressInfo

    const response = await fetch(`http://127.0.0.1:${address.port}/missing`, { redirect: 'manual' })

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'not_found' })
  })
})
