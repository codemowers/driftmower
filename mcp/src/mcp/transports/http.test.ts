import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMcpServer } from '../create-server.js'
import { startHttpTransport } from './http.js'

describe('HTTP MCP transport', () => {
  let httpServer: Server | undefined
  let client: Client | undefined

  afterEach(async () => {
    await client?.close()

    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer?.close(error => (error ? reject(error) : resolve()))
      })
    }
  })

  it('serves search_workloads on /mcp', async () => {
    const searchWorkloads = vi.fn().mockResolvedValue({ query: 'api', matches: [] })
    const mcpServer = createMcpServer({ workloadSearchService: { searchWorkloads } })
    const serverErrors: unknown[] = []

    httpServer = await startHttpTransport(mcpServer, {
      host: '127.0.0.1',
      port: 0,
      onError: error => serverErrors.push(error)
    })
    const address = httpServer.address() as AddressInfo

    client = new Client({ name: 'http-test-client', version: '1.0.0' })
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

    expect(result.structuredContent).toEqual({ query: 'api', matches: [] })
    expect(searchWorkloads).toHaveBeenCalledWith({ query: 'api', limit: undefined })
  })
})
