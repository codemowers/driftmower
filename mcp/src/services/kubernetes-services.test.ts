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
        namespaceRole: 'admin',
        usernamePrefix: 'issuer#',
        groupsPrefix: '',
        requestTimeoutMs: 10000
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
        'describe_cluster_capabilities',
        'describe_custom_resource_definition',
        'get_cluster_identity',
        'get_engineering_advisory',
        'list_accessible_namespaces',
        'list_admission_policies',
        'list_storage_classes'
      ])
      for (const tool of tools.filter(
        tool => !['get_engineering_advisory', 'get_cluster_identity'].includes(tool.name)
      )) {
        const result = await client.callTool({
          name: tool.name,
          arguments:
            tool.name === 'describe_custom_resource_definition' ? { name: 'widgets.example.com' } : {}
        })

        expect(result.isError).toBe(true)
        expect(JSON.stringify(result.content)).toContain('authenticated')
      }
    } finally {
      await client.close()
      await server.close()
    }
  })
})
