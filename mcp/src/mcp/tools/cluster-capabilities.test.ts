import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { expect, it, vi } from 'vitest'
import { createClusterCapabilities } from '../../clients/cluster-capabilities.js'
import { registerClusterCapabilitiesTool } from './cluster-capabilities.js'

it('defaults CRDs to namespace scope, allows explicit cluster scope and reads independent catalogs', async () => {
  const read = vi.fn(async (path: string) =>
    JSON.stringify({
      items: path.includes('customresourcedefinitions')
        ? ['Namespaced', 'Cluster'].map(scope => ({
            metadata: { name: scope.toLowerCase() + '.example.com' },
            spec: {
              group: 'example.com',
              scope,
              names: { kind: scope, plural: scope.toLowerCase() },
              versions: [{ name: 'v1', served: true, storage: true }]
            }
          }))
        : []
    })
  )
  const server = new McpServer({ name: 'test', version: '1' })

  registerClusterCapabilitiesTool(server, createClusterCapabilities(read), { id: 'test' } as never)
  const client = new Client({ name: 'test', version: '1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const onmessage = st.onmessage

  await server.connect(st)
  const handler = st.onmessage!

  st.onmessage = (message, extra) =>
    handler(message, {
      ...extra,
      authInfo: { token: 'verified', clientId: 'test', scopes: [], extra: { sub: 'alice' } }
    })
  await client.connect(ct)
  try {
    const tools = (await client.listTools()).tools.map(tool => tool.name)

    expect(tools).not.toContain('describe_cluster_capabilities')
    expect(tools).toContain('list_cluster_issuers')
    const ns = await client.callTool({ name: 'list_custom_resource_definitions', arguments: {} })

    expect(ns.structuredContent).toMatchObject({ customResources: [{ scope: 'Namespaced' }] })
    const cluster = await client.callTool({
      name: 'list_custom_resource_definitions',
      arguments: { scope: 'Cluster' }
    })

    expect(cluster.structuredContent).toMatchObject({ customResources: [{ scope: 'Cluster' }] })
    read.mockClear()
    await client.callTool({ name: 'list_ingress_classes', arguments: {} })
    expect(read.mock.calls.map(([path]) => path)).toEqual([
      '/apis/networking.k8s.io/v1/ingressclasses?limit=10'
    ])
    read.mockClear()
    await client.callTool({ name: 'list_priority_classes', arguments: {} })
    expect(read.mock.calls.map(([path]) => path)).toEqual([
      '/apis/scheduling.k8s.io/v1/priorityclasses?limit=10'
    ])
  } finally {
    st.onmessage = onmessage
    await client.close()
    await server.close()
  }
})
