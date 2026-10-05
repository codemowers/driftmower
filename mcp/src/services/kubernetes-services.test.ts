import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { createKubernetesServices } from './kubernetes-services.js'
import { createMcpServer } from '../mcp/create-server.js'

describe('independent Kubernetes services', () => {
  it('registers catalogs and namespace discovery with observability disabled and no mounted credentials', async () => {
    const dependencies = createKubernetesServices(
      {
        url: 'https://kubernetes.default.svc',
        tokenFile: '/does-not-exist/token',
        caFile: '/does-not-exist/ca',
        usernameClaim: 'sub',
        groupsClaim: 'groups',
        usernamePrefix: 'issuer#',
        groupsPrefix: '',
        requestTimeoutMs: 10000,
        sarCacheTtlMs: 0,
        rbacWatchEnabled: false
      },
      null
    )

    expect(dependencies.observability).toBeUndefined()
    const server = createMcpServer(dependencies)
    const client = new Client({ name: 'test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)
    try {
      const { tools } = await client.listTools()

      expect(tools.map(tool => tool.name).sort()).toEqual([
        'check_access',
        'describe_custom_resource_definition',
        'describe_namespace_readiness',
        'describe_provisioning_platform',
        'get_cluster_identity',
        'get_workloads',
        'list_accessible_namespaces',
        'list_admission_policies',
        'list_cluster_issuers',
        'list_custom_resource_definitions',
        'list_ingress_classes',
        'list_offerings',
        'list_pods',
        'list_priority_classes',
        'list_storage_classes',
        'list_volumes'
      ])
      // The provisioning tools answer unauthenticated callers with unknown
      // verdicts rather than refusing, so they are exercised separately.
      const provisioning = [
        'check_access',
        'describe_namespace_readiness',
        'describe_provisioning_platform',
        'list_offerings'
      ]

      for (const tool of tools.filter(
        tool => !['get_engineering_advisory', 'get_cluster_identity', ...provisioning].includes(tool.name)
      )) {
        const result = await client.callTool({
          name: tool.name,
          arguments:
            tool.name === 'describe_custom_resource_definition'
              ? { name: 'widgets.example.com' }
              : tool.name === 'list_pods'
                ? { namespace: 'demo' }
                : {}
        })

        expect(result.isError).toBe(true)
        expect(JSON.stringify(result.content)).toContain('authenticated')
      }
    } finally {
      await client.close()
      await server.close()
      await dependencies.workloads.service.stop()
    }
  })
})
