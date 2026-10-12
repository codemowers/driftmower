import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { expect, it, vi } from 'vitest'
import { registerClusterPlatformTool } from './cluster-platform.js'
import { createClusterPlatformDiscovery } from '../../clients/cluster-platform.js'

it('exports the platform with cluster scope and requires an authenticated caller', async () => {
  const server = { registerTool: vi.fn() }
  const read = vi.fn()
  const cluster = { id: 'example', apiUrl: 'https://api.example', mcpServerName: 'example' }

  registerClusterPlatformTool(
    server as unknown as McpServer,
    createClusterPlatformDiscovery(read, 'vanilla'),
    cluster
  )
  const [name, config, handler] = server.registerTool.mock.calls[0]

  expect(name).toBe('get_cluster_platform')
  expect(config.annotations.readOnlyHint).toBe(true)
  await expect(handler({}, {})).rejects.toThrow('authenticated')
  expect(read).not.toHaveBeenCalled()
  expect(await handler({}, { authInfo: { extra: { sub: 'verified-user' } } })).toMatchObject({
    structuredContent: { cluster, platform: { kind: 'vanilla', source: 'configured' } }
  })
})
