import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import { createMcpServer } from '../create-server.js'
import { registerWorkloadActions } from './workload-actions.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolCallContext } from './caller-scope.js'
import { WorkloadActions } from '../../services/workload-actions.js'

const mapping = {
  usernameClaim: 'sub',
  groupsClaim: 'groups',
  usernamePrefix: 'issuer#',
  groupsPrefix: 'oidc:'
}

it.each([false, true])('exposes mutating tools only when enabled: %s', async enabled => {
  const request = vi.fn()
  const server = createMcpServer(
    enabled ? { workloadActions: { service: new WorkloadActions(request), identityMapping: mapping } } : {}
  )
  const client = new Client({ name: 'test', version: '1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()

  await server.connect(st)
  await client.connect(ct)
  try {
    const tools = (await client.listTools()).tools
    const mutations = tools.filter(tool => ['restart_workload', 'terminate_pod'].includes(tool.name))

    expect(mutations).toHaveLength(enabled ? 2 : 0)
    for (const tool of mutations)
      expect(tool.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false
      })
    expect(request).not.toHaveBeenCalled()
  } finally {
    await client.close()
    await server.close()
  }
})

it('rejects anonymous calls and passes only verified caller identity to actions', async () => {
  const callbacks = new Map<string, (input: never, context: ToolCallContext) => Promise<unknown>>()
  const registerTool = vi.fn((name, _definition, callback) => callbacks.set(name, callback))
  const service = new WorkloadActions(vi.fn())
  const restart = vi
    .spyOn(service, 'restart')
    .mockResolvedValue({ action: 'restart', status: 'requested', message: 'Requested' } as never)

  registerWorkloadActions({ registerTool } as unknown as McpServer, service, mapping)
  const handler = callbacks.get('restart_workload')!
  const args = { namespace: 'demo', name: 'app', uid: 'uid', kind: 'Deployment', apiVersion: 'apps/v1' }

  await expect(handler(args as never, {})).rejects.toThrow('authenticated')
  expect(restart).not.toHaveBeenCalled()
  await handler(args as never, {
    authInfo: {
      token: 'verified',
      clientId: 'client',
      scopes: [],
      extra: { sub: 'alice', groups: ['developers'] }
    }
  })
  expect(restart).toHaveBeenCalledExactlyOnceWith(args, {
    user: 'issuer#alice',
    groups: ['system:authenticated', 'oidc:developers']
  })
})
