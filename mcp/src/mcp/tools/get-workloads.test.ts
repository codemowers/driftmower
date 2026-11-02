import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { expect, it, vi } from 'vitest'
import { registerGetWorkloadsTool } from './get-workloads.js'
import type { ToolCallContext } from './caller-scope.js'

it('uses verified Kubernetes identity and returns condensed inventory without duplicating it as text', async () => {
  let handler: (input: { namespace?: string }, context: ToolCallContext) => Promise<unknown>
  const registerTool = vi.fn((_name, _definition, callback) => {
    handler = callback
  })
  const inventory = {
    workloads: [
      { name: 'app', kind: 'Deployment', namespace: 'team', pods: ['app-0'] },
      { name: 'orphaned-workloads', kind: 'Namespace', namespace: 'team' }
    ]
  }
  const service = { listWorkloads: vi.fn().mockResolvedValue(inventory) }

  registerGetWorkloadsTool({ registerTool } as unknown as McpServer, service, {
    usernameClaim: 'sub',
    groupsClaim: 'groups',
    usernamePrefix: 'issuer#',
    groupsPrefix: 'oidc:'
  })
  await expect(handler!({}, {})).rejects.toThrow('authenticated')
  expect(service.listWorkloads).not.toHaveBeenCalled()
  const result = await handler!(
    { namespace: 'team' },
    {
      authInfo: {
        token: 'verified',
        clientId: 'client',
        scopes: [],
        extra: { sub: 'alice', groups: ['dev'], namespaces: ['not-authoritative'] }
      }
    }
  )

  expect(service.listWorkloads).toHaveBeenCalledExactlyOnceWith(
    { namespace: 'team' },
    { user: 'issuer#alice', groups: ['system:authenticated', 'oidc:dev'] }
  )
  expect(result).toEqual({
    structuredContent: inventory,
    content: [{ type: 'text', text: '1 workloads; 1 namespace orphan buckets.' }]
  })
})
