import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SearchWorkloadsResult, WorkloadMatch } from '../../domain/workload-result.js'
import { createMcpServer } from '../create-server.js'
import { SEARCH_WORKLOADS_TOOL_NAME } from './search-workloads.js'

const UNSCOPED = { scoped: false, namespaces: null, note: null }

function match(namespace: string, name: string): WorkloadMatch {
  return {
    workloadId: `${namespace}/${name}`,
    name,
    kind: 'Deployment',
    cluster: null,
    namespace,
    analysis: { status: 'current', helm: null, images: [] },
    snapshot: { reportId: 'report-1', createdAt: '2026-09-14T00:00:00Z' }
  }
}

describe('search_workloads tool output', () => {
  const closeCallbacks: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map(close => close()))
  })

  async function callWith(result: SearchWorkloadsResult) {
    const server = createMcpServer({
      workloadSearchService: { searchWorkloads: vi.fn().mockResolvedValue(result) },
      imageUpdatePlanningService: { planImageUpdates: vi.fn() }
    })
    const client = new Client({ name: 'search-workloads-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    closeCallbacks.push(async () => {
      await client.close()
      await server.close()
    })

    return client.callTool({ name: SEARCH_WORKLOADS_TOOL_NAME, arguments: { query: result.query } })
  }

  it('advertises an output schema and read-only annotations', async () => {
    const server = createMcpServer({
      workloadSearchService: { searchWorkloads: vi.fn() },
      imageUpdatePlanningService: { planImageUpdates: vi.fn() }
    })
    const client = new Client({ name: 'search-workloads-schema-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    closeCallbacks.push(async () => {
      await client.close()
      await server.close()
    })

    const { tools } = await client.listTools()
    const tool = tools.find(candidate => candidate.name === SEARCH_WORKLOADS_TOOL_NAME)

    // Without a declared output schema a strict client cannot trust
    // structuredContent and has to parse the text block instead.
    expect(tool?.outputSchema?.properties).toHaveProperty('matches')
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false })
  })

  it('summarises matches instead of repeating the payload as JSON', async () => {
    const result: SearchWorkloadsResult = {
      query: 'api',
      matches: [match('payments', 'api'), match('billing', 'api-worker')],
      scope: UNSCOPED
    }

    const toolResult = await callWith(result)

    expect(toolResult.content).toEqual([
      { type: 'text', text: '2 workload(s) match `api`: payments/api, billing/api-worker.' }
    ])
    // The full payload is still available, just not twice.
    expect(toolResult.structuredContent).toEqual(result)
  })

  it('counts the remainder once the summary stops naming matches', async () => {
    const result: SearchWorkloadsResult = {
      query: 'api',
      matches: Array.from({ length: 7 }, (_, index) => match('payments', `api-${index}`)),
      scope: UNSCOPED
    }

    const [{ text }] = (await callWith(result)).content as Array<{ text: string }>

    expect(text).toBe(
      '7 workload(s) match `api`: payments/api-0, payments/api-1, payments/api-2, ' +
        'payments/api-3, payments/api-4 and 2 more.'
    )
  })

  it('carries the scope note so a withheld result does not read as an empty one', async () => {
    const note =
      'Your access token carries no namespaces claim, so no results can be returned. ' +
      'Request the `namespaces` scope when obtaining the token; this is a token problem, not an empty cluster.'
    const result: SearchWorkloadsResult = {
      query: 'api',
      matches: [],
      scope: { scoped: true, namespaces: [], note }
    }

    const [{ text }] = (await callWith(result)).content as Array<{ text: string }>

    expect(text).toBe(`No workloads match \`api\`.${' ' + note}`)
  })
})
