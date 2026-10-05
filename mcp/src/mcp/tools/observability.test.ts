import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'
import { createMcpServer } from '../create-server.js'
import { ObservabilityService } from '../../services/observability-service.js'
import { observabilityCaller } from './observability.js'

const mapping = {
  usernameClaim: 'sub',
  groupsClaim: 'groups',
  usernamePrefix: 'https://auth.example/#',
  groupsPrefix: ''
}

describe('observability MCP tools', () => {
  it('maps the verified caller through the Kubernetes identity mapping', () => {
    expect(
      observabilityCaller(
        {
          authInfo: {
            token: 'verified',
            clientId: 'mcp',
            scopes: [],
            extra: { sub: 'alice', groups: ['admins', 'system:authenticated', 7] }
          }
        },
        mapping
      )
    ).toEqual({
      identity: {
        user: 'https://auth.example/#alice',
        groups: ['system:authenticated', 'admins']
      }
    })
    expect(observabilityCaller({}, mapping)).toBeUndefined()
  })

  it.each([true, false])(
    'registers standalone tools (Prometheus configured: %s) and refuses anonymous calls',
    async metrics => {
      const allowed = vi.fn()
      const service = new ObservabilityService({
        prometheusUrl: metrics ? 'http://prometheus' : null,
        lokiUrl: null,
        kubernetes: { allowed, podLogs: vi.fn() },
        request: vi.fn()
      })
      const server = createMcpServer({ observability: { service, identityMapping: mapping } })
      const client = new Client({ name: 'test', version: '1' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

      await server.connect(serverTransport)
      await client.connect(clientTransport)
      try {
        const tools = await client.listTools()

        expect(tools.tools.map(tool => tool.name)).toEqual(
          metrics
            ? [
                'get_cluster_identity',
                'get_pod_resource_usage',
                'get_cluster_resource_usage',
                'get_pod_resource_usage_history',
                'get_cluster_resource_usage_history',
                'query_metrics',
                'query_logs'
              ]
            : ['get_cluster_identity', 'query_logs']
        )
        expect(tools.tools.every(tool => tool.annotations?.readOnlyHint)).toBe(true)
        const result = await client.callTool({
          name: 'query_logs',
          arguments: { namespace: 'a', pod: 'api' }
        })

        expect(result.isError).toBe(true)
        expect(allowed).not.toHaveBeenCalled()
      } finally {
        await client.close()
        await server.close()
      }
    }
  )
})
