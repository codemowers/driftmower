import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NamespaceReadiness, ProvisioningService } from '../../services/provisioning-service.js'
import { summariseMatrix, VERBS, type Verb, type Verdict } from '../../domain/provisioning/access-facts.js'
import { z } from 'zod'
import { describeNamespaceReadinessOutputShape } from './provisioning-schemas.js'
import { createMcpServer } from '../create-server.js'
import {
  CHECK_ACCESS_TOOL_NAME,
  DESCRIBE_NAMESPACE_READINESS_TOOL_NAME,
  DESCRIBE_PROVISIONING_PLATFORM_TOOL_NAME,
  LIST_OFFERINGS_TOOL_NAME
} from './provisioning.js'

const PROVISIONING_TOOLS = [
  DESCRIBE_PROVISIONING_PLATFORM_TOOL_NAME,
  LIST_OFFERINGS_TOOL_NAME,
  DESCRIBE_NAMESPACE_READINESS_TOOL_NAME,
  CHECK_ACCESS_TOOL_NAME
]
const identityMapping = {
  usernameClaim: 'sub',
  groupsClaim: 'groups',
  usernamePrefix: 'issuer#',
  groupsPrefix: ''
}

describe('provisioning tools', () => {
  const closeCallbacks: Array<() => Promise<void>> = []

  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map(close => close()))
  })

  async function connect(service?: ProvisioningService): Promise<Client> {
    const server = createMcpServer({
      workloadSearchService: { searchWorkloads: vi.fn() },
      imageUpdatePlanningService: { planImageUpdates: vi.fn() },
      provisioning: service ? { service, identityMapping } : undefined
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

  it('does not advertise provisioning tools without a service', async () => {
    const client = await connect(undefined)
    const { tools } = await client.listTools()
    const names = tools.map(tool => tool.name)

    for (const name of PROVISIONING_TOOLS) expect(names).not.toContain(name)

    expect(names).toEqual(expect.arrayContaining(['search_workloads', 'plan_image_updates']))
  })

  it('provides provisioning discovery steps at connection, resource and identity boundaries', async () => {
    const service = stubService()
    const client = await connect(service)
    const instructions = client.getInstructions()!

    for (const name of PROVISIONING_TOOLS) expect(instructions).toContain(name)

    expect(instructions.indexOf('start with describe_provisioning_platform')).toBeLessThan(
      instructions.indexOf('then list_offerings')
    )
    expect(instructions).toContain('Supply offering and the intended namespace when known')
    expect(instructions).toContain('authorization does not guarantee admission')
    const guide = await client.readResource({ uri: 'driftmower://cluster/discovery-guide' })

    expect(guide.contents[0]).toMatchObject({ text: instructions })
    const identity = await client.callTool({ name: 'get_cluster_identity', arguments: {} })
    const content = identity.structuredContent as Record<string, unknown>

    for (const name of PROVISIONING_TOOLS) expect(content.discoveryInstructions).toContain(name)

    expect(service.describeProvisioningPlatform).not.toHaveBeenCalled()
    expect(service.listOfferings).not.toHaveBeenCalled()
    expect(service.describeNamespaceReadiness).not.toHaveBeenCalled()
    expect(service.checkAccess).not.toHaveBeenCalled()
  })

  it('registers every provisioning tool as read-only and non-destructive', async () => {
    const client = await connect(stubService())
    const { tools } = await client.listTools()

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
    const service = stubService()
    const client = await connect(service)
    const result = await client.callTool({
      name: LIST_OFFERINGS_TOOL_NAME,
      arguments: { namespace: 'team-a' }
    })

    expect(result.structuredContent).toMatchObject({ status: 'ok' })
    expect(Array.isArray(result.content) && result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('ready')
    })
    // Unauthenticated in-memory transport: no identity reaches the service.
    expect(service.listOfferings).toHaveBeenCalledWith(null, undefined, 'team-a')
  })

  it('passes an unavailable answer through as a normal result, not a protocol error', async () => {
    const service = stubService()

    vi.mocked(service.describeProvisioningPlatform).mockResolvedValue({
      status: 'unavailable',
      reason: 'kubernetes_unreachable',
      detail: 'The Kubernetes API could not be read: ECONNREFUSED'
    })
    const client = await connect(service)
    const result = await client.callTool({ name: DESCRIBE_PROVISIONING_PLATFORM_TOOL_NAME, arguments: {} })

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({
      status: 'unavailable',
      reason: 'kubernetes_unreachable'
    })
  })

  it('rejects a namespace list longer than the configured cap', async () => {
    const client = await connect(stubService())
    const result = await client.callTool({
      name: DESCRIBE_NAMESPACE_READINESS_TOOL_NAME,
      arguments: { namespaces: Array.from({ length: 4 }, (_, index) => `ns-${index}`) }
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('expected array to have <=3 items')
  })

  it('returns only creatable names without permission rows and preserves service facts', async () => {
    const service = stubService()
    const row = Object.fromEntries(VERBS.map(verb => [verb, 'yes'])) as Record<Verb, Verdict>
    const access = summariseMatrix(
      {
        'example.com/allowed': row,
        'example.com/denied': { ...row, create: 'no' },
        'example.com/uncertain': { ...row, create: 'unknown' }
      },
      []
    )
    const facts: NamespaceReadiness = {
      status: 'ok',
      requested: ['team-a'],
      withheld: [],
      degraded: [],
      hostRules: [],
      namespaces: [
        {
          namespace: 'team-a',
          tenant: null,
          sandbox: null,
          quota: null,
          headroom: null,
          limitRange: null,
          podSecurity: null,
          registries: [],
          offerings: {},
          network: { ingress: 'unknown', egress: 'unknown', selectors: [], ciliumAvailable: false },
          access,
          mayCreate: 'unknown',
          mayCreateReason: 'No offering selected'
        }
      ]
    }

    vi.mocked(service.describeNamespaceReadiness).mockResolvedValue(facts)
    const client = await connect(service)
    const result = await client.callTool({
      name: DESCRIBE_NAMESPACE_READINESS_TOOL_NAME,
      arguments: { namespaces: ['team-a'] }
    })
    const parsed = z.object(describeNamespaceReadinessOutputShape).parse(result.structuredContent)

    expect(parsed.namespaces?.[0].creatableResources).toEqual(['example.com/allowed'])
    expect(parsed.namespaces?.[0]).not.toHaveProperty('access')
    expect(JSON.stringify(result.structuredContent)).not.toContain('matrix')
    expect(JSON.stringify(result.content)).not.toContain('Access (from the cluster authorizer)')
    expect(facts.namespaces[0].access).toBe(access)
    expect(Object.keys(access.matrix)).toHaveLength(3)

    facts.namespaces[0].access = null
    const unchecked = await client.callTool({
      name: DESCRIBE_NAMESPACE_READINESS_TOOL_NAME,
      arguments: { namespaces: ['team-a'] }
    })

    expect(
      z.object(describeNamespaceReadinessOutputShape).parse(unchecked.structuredContent).namespaces?.[0]
        .creatableResources
    ).toBeNull()
  })

  it('asks one exact permission question and reports the verdict', async () => {
    const service = stubService()
    const client = await connect(service)
    const result = await client.callTool({
      name: CHECK_ACCESS_TOOL_NAME,
      arguments: { verb: 'create', group: 'kafka.strimzi.io', resource: 'kafkas', namespace: 'team-a' }
    })

    expect(service.checkAccess).toHaveBeenCalledWith(null, {
      verb: 'create',
      group: 'kafka.strimzi.io',
      resource: 'kafkas',
      namespace: 'team-a'
    })
    expect(result.structuredContent).toMatchObject({ status: 'ok', verdict: 'no' })
    expect(JSON.stringify(result.content)).toContain(
      'create kafkas.kafka.strimzi.io in namespace team-a — no'
    )
  })
})

function stubService(): ProvisioningService {
  return {
    maxNamespaces: 3,
    describeProvisioningPlatform: vi.fn().mockResolvedValue({
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
        tlsAdvice: ''
      },
      policies: [],
      admissionPolicies: [],
      tenantLabelKey: null,
      offeringsReady: 0,
      offeringsTotal: 0,
      degraded: []
    }),
    listOfferings: vi.fn().mockResolvedValue({ status: 'ok', offerings: [], withheld: [], degraded: [] }),
    describeNamespaceReadiness: vi.fn().mockResolvedValue({
      status: 'ok',
      requested: [],
      namespaces: [],
      hostRules: [],
      withheld: [],
      degraded: []
    }),
    checkAccess: vi.fn().mockResolvedValue({
      status: 'ok',
      verdict: 'no',
      reason: 'Kubernetes RBAC denies create kafkas.kafka.strimzi.io in namespace team-a',
      rbac: {
        verdict: 'no',
        reason: 'Kubernetes RBAC denies create kafkas.kafka.strimzi.io in namespace team-a'
      },
      admission: [],
      admissionDefaults: [],
      identity: null
    })
  } as unknown as ProvisioningService
}
