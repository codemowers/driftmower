import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkloadSearchService } from '../services/workload-search-service.js'
import { createMcpServer } from './create-server.js'

describe('createMcpServer', () => {
  const closeCallbacks: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map(close => close()))
  })

  it('registers search_workloads and returns text plus structured content', async () => {
    const result = { query: 'api', matches: [] }
    const searchWorkloads = vi.fn().mockResolvedValue(result)
    const { client } = await connectClient(searchWorkloads)

    const tools = await client.listTools()
    const toolResult = await client.callTool({
      name: 'search_workloads',
      arguments: { query: 'api', limit: 3 }
    })

    expect(tools.tools.map(tool => tool.name)).toContain('search_workloads')
    expect(searchWorkloads).toHaveBeenCalledWith({ query: 'api', limit: 3 })
    expect(toolResult.structuredContent).toEqual(result)
    expect(toolResult.content).toEqual([{ type: 'text', text: JSON.stringify(result) }])
  })

  it('rejects an empty query at the MCP input boundary', async () => {
    const searchWorkloads = vi.fn()
    const { client } = await connectClient(searchWorkloads)

    const result = await client.callTool({
      name: 'search_workloads',
      arguments: { query: '   ' }
    })

    expect(result.isError).toBe(true)
    expect(searchWorkloads).not.toHaveBeenCalled()
  })

  async function connectClient(
    searchWorkloads: WorkloadSearchService['searchWorkloads']
  ): Promise<{ client: Client }> {
    const server = createMcpServer({ workloadSearchService: { searchWorkloads } })
    const client = new Client({ name: 'test-client', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)
    closeCallbacks.push(async () => {
      await client.close()
      await server.close()
    })

    return { client }
  }
})
