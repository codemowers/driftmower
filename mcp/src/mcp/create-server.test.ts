import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlanImageUpdatesResult } from '../domain/image-update-plan.js'
import { UNRESTRICTED_SCOPE } from '../domain/tenancy.js'
import type { ImageUpdatePlanningService } from '../services/image-update-planning-service.js'
import type { WorkloadSearchService } from '../services/workload-search-service.js'
import { createMcpServer } from './create-server.js'
import { planImageUpdatesOutputSchema } from './tools/plan-image-updates.js'

const NO_READY_REPORT_RESULT: PlanImageUpdatesResult = {
  status: 'no_ready_report',
  filters: {
    namespace: null,
    versionStatuses: ['major_behind', 'minor_behind', 'patch_behind', 'behind']
  },
  snapshot: null,
  summary: {
    uniqueImageCandidates: 0,
    totalActions: 0,
    imageTagUpdates: 0,
    helmChartUpdates: 0,
    manualReviews: 0
  },
  actions: [],
  nextCursor: null,
  warnings: ['This plan is based on a Driftmower analysis snapshot, not live cluster state.'],
  scope: { scoped: false, namespaces: null, note: null }
}

describe('createMcpServer', () => {
  const closeCallbacks: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map(close => close()))
  })

  it('supports resource discovery and publishes the connection guide without reading cluster data', async () => {
    const searchWorkloads = vi.fn()
    const planImageUpdates = vi.fn()
    const { client } = await connectClient(searchWorkloads, planImageUpdates)

    expect(client.getServerCapabilities()?.resources).toBeDefined()
    const { resources } = await client.listResources()

    expect(resources).toContainEqual(
      expect.objectContaining({
        name: 'cluster-discovery-guide',
        uri: 'driftmower://cluster/discovery-guide',
        mimeType: 'text/plain'
      })
    )
    expect(await client.listResourceTemplates()).toEqual({ resourceTemplates: [] })
    const guide = await client.readResource({ uri: resources[0].uri })
    const guideText = 'text' in guide.contents[0] ? guide.contents[0].text : undefined

    expect(guideText).toBe(client.getInstructions())
    expect(guideText).not.toContain('start with describe_provisioning_platform')
    expect(guideText).not.toContain('Use list_admission_policies')
    expect(searchWorkloads).not.toHaveBeenCalled()
    expect(planImageUpdates).not.toHaveBeenCalled()

    const identity = await client.callTool({ name: 'get_cluster_identity', arguments: {} })

    const content = identity.structuredContent as Record<string, unknown>

    expect(content.discoveryInstructions).toContain('search_workloads')
    expect(content.discoveryInstructions).not.toContain('list_offerings')
  })

  it('registers search_workloads and returns text plus structured content', async () => {
    const result = { query: 'api', matches: [], scope: { scoped: false, namespaces: null, note: null } }
    const searchWorkloads = vi.fn().mockResolvedValue(result)
    const planImageUpdates = vi.fn().mockResolvedValue(NO_READY_REPORT_RESULT)
    const { client } = await connectClient(searchWorkloads, planImageUpdates)

    const tools = await client.listTools()
    const toolResult = await client.callTool({
      name: 'search_workloads',
      arguments: { query: 'api', limit: 3 }
    })

    expect(tools.tools.map(tool => tool.name)).toContain('search_workloads')
    expect(searchWorkloads).toHaveBeenCalledWith({ query: 'api', limit: 3, scope: UNRESTRICTED_SCOPE })
    expect(toolResult.structuredContent).toEqual(result)
    expect(toolResult.content).toEqual([{ type: 'text', text: 'No workloads match `api`.' }])
  })

  it('rejects an empty query at the MCP input boundary', async () => {
    const searchWorkloads = vi.fn()
    const planImageUpdates = vi.fn()
    const { client } = await connectClient(searchWorkloads, planImageUpdates)

    const result = await client.callTool({
      name: 'search_workloads',
      arguments: { query: '   ' }
    })

    expect(result.isError).toBe(true)
    expect(searchWorkloads).not.toHaveBeenCalled()
  })

  it('registers plan_image_updates as read-only and returns matching output forms', async () => {
    const searchWorkloads = vi.fn()
    const planImageUpdates = vi.fn().mockResolvedValue(NO_READY_REPORT_RESULT)
    const { client } = await connectClient(searchWorkloads, planImageUpdates)

    const tools = await client.listTools()
    const planTool = tools.tools.find(tool => tool.name === 'plan_image_updates')
    const result = await client.callTool({
      name: 'plan_image_updates',
      arguments: {
        namespace: 'payments',
        versionStatuses: ['major_behind', 'patch_behind'],
        limit: 25
      }
    })

    expect(planTool).toMatchObject({
      name: 'plan_image_updates',
      title: 'Plan Driftmower image updates',
      annotations: {
        readOnlyHint: true,
        openWorldHint: false
      }
    })
    expect(planImageUpdates).toHaveBeenCalledWith({
      namespace: 'payments',
      versionStatuses: ['major_behind', 'patch_behind'],
      limit: 25,
      scope: UNRESTRICTED_SCOPE
    })
    expect(result.structuredContent).toEqual(NO_READY_REPORT_RESULT)
    expect(result.content).toEqual([
      { type: 'text', text: 'No ready Driftmower snapshot, so no update plan could be built.' }
    ])
    expect(planImageUpdatesOutputSchema.parse(result.structuredContent)).toEqual(NO_READY_REPORT_RESULT)
    expect(planTool?.inputSchema.properties).not.toHaveProperty('cluster')
  })

  it('rejects duplicate version statuses at the planning tool boundary', async () => {
    const searchWorkloads = vi.fn()
    const planImageUpdates = vi.fn()
    const { client } = await connectClient(searchWorkloads, planImageUpdates)

    const result = await client.callTool({
      name: 'plan_image_updates',
      arguments: {
        versionStatuses: ['major_behind', 'major_behind']
      }
    })

    expect(result.isError).toBe(true)
    expect(planImageUpdates).not.toHaveBeenCalled()
  })

  async function connectClient(
    searchWorkloads: WorkloadSearchService['searchWorkloads'],
    planImageUpdates: ImageUpdatePlanningService['planImageUpdates']
  ): Promise<{ client: Client }> {
    const server = createMcpServer({
      workloadSearchService: { searchWorkloads },
      imageUpdatePlanningService: { planImageUpdates }
    })
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
