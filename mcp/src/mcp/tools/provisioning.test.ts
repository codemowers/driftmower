import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProvisioningService } from '../../services/provisioning-service.js'
import { createMcpServer } from '../create-server.js'
import { DESCRIBE_NAMESPACE_READINESS_TOOL_NAME, LIST_OFFERINGS_TOOL_NAME } from './provisioning.js'

const PROVISIONING_TOOLS = [LIST_OFFERINGS_TOOL_NAME, DESCRIBE_NAMESPACE_READINESS_TOOL_NAME]

describe('provisioning tools', () => {
  const closeCallbacks: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map(close => close()))
  })

  async function connect(provisioningService?: ProvisioningService): Promise<Client> {
    const server = createMcpServer({
      workloadSearchService: { searchWorkloads: vi.fn() },
      imageUpdatePlanningService: { planImageUpdates: vi.fn() },
      provisioningService
    })
    const client = new Client({ name: 'provisioning-test', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    closeCallbacks.push(async () => {
      await client.close()
      await server.close()
    })

    return client
  }

  it('does not advertise provisioning tools when driftmower-ui is not configured', async () => {
    // Better than registering tools that always fail: a client can see up front
    // that this deployment does not serve them.
    const client = await connect(undefined)
    const { tools } = await client.listTools()
    const names = tools.map(tool => tool.name)

    for (const name of PROVISIONING_TOOLS) {
      expect(names).not.toContain(name)
    }

    expect(names).toEqual(expect.arrayContaining(['search_workloads', 'plan_image_updates']))
  })

  it('registers every provisioning tool as read-only and non-destructive', async () => {
    const client = await connect(stubService())
    const { tools } = await client.listTools()

    expect(tools.map(tool => tool.name)).not.toContain('explain_storage_class')

    for (const name of PROVISIONING_TOOLS) {
      const tool = tools.find(candidate => candidate.name === name)

      expect(tool, `${name} is registered`).toBeDefined()
      expect(tool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      })
      expect(tool?.outputSchema, `${name} declares an output schema`).toBeDefined()
    }
  })

  it('returns markdown and structured content that satisfies the declared schema', async () => {
    const client = await connect(stubService())

    const result = await client.callTool({
      name: LIST_OFFERINGS_TOOL_NAME,
      arguments: {}
    })

    expect(result.structuredContent).toMatchObject({ status: 'ok' })
    expect(Array.isArray(result.content) && result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('ready')
    })
  })

  it('passes an unavailable answer through as a normal result, not a protocol error', async () => {
    const service = stubService()

    vi.mocked(service.listOfferings).mockResolvedValue({
      status: 'unavailable',
      reason: 'unreachable',
      detail: 'driftmower-ui is down'
    })

    const client = await connect(service)
    const result = await client.callTool({ name: LIST_OFFERINGS_TOOL_NAME, arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ status: 'unavailable', reason: 'unreachable' })
  })

  it('rejects a namespace list longer than the fan-out cap', async () => {
    const client = await connect(stubService())

    const result = await client.callTool({
      name: DESCRIBE_NAMESPACE_READINESS_TOOL_NAME,
      arguments: { namespaces: Array.from({ length: 13 }, (_, index) => `ns-${index}`) }
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('expected array to have <=12 items')
  })
})

function stubService(): ProvisioningService {
  return {
    describeClusterCapabilities: vi.fn().mockResolvedValue({
      status: 'ok',
      storageClasses: [],
      topology: { zones: [], schedulableNodes: 1, controlPlaneLabel: null },
      priorityClasses: [],
      networkPolicyEngine: 'native',
      monitoringOperator: false,
      ingress: {
        domainSuffix: null,
        domainSuffixSource: null,
        classes: [],
        clusterIssuers: [],
        sharedWildcard: false,
        tlsAdvice: '',
        hostRules: []
      },
      policies: [],
      admissionPolicies: [],
      offeringsReady: 0,
      offeringsTotal: 0,
      degraded: []
    }),
    listOfferings: vi.fn().mockResolvedValue({ status: 'ok', offerings: [], degraded: [] }),
    describeNamespaceReadiness: vi.fn().mockResolvedValue({
      status: 'ok',
      requested: [],
      namespaces: [],
      hostRules: [],
      withheld: [],
      degraded: []
    })
  } as unknown as ProvisioningService
}
