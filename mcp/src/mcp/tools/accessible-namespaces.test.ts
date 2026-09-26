import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it, vi } from 'vitest'
import { registerAccessibleNamespacesTool } from './accessible-namespaces.js'
import type { ToolCallContext } from './caller-scope.js'

describe('accessible namespaces tool', () => {
  it('uses only the verified mapped identity and refuses anonymous calls', async () => {
    let handler: (_input: object, context: ToolCallContext) => Promise<unknown>
    const registerTool = vi.fn((_name, _definition, callback) => {
      handler = callback
    })
    const service = {
      listAccessibleNamespaces: vi.fn().mockResolvedValue({ namespaces: ['team-a'] })
    }

    registerAccessibleNamespacesTool({ registerTool } as unknown as McpServer, service, {
      usernamePrefix: 'issuer#',
      groupsPrefix: 'oidc:'
    })
    expect(registerTool.mock.calls[0][0]).toBe('list_accessible_namespaces')
    await expect(handler!({}, {})).rejects.toThrow('authenticated')
    expect(service.listAccessibleNamespaces).not.toHaveBeenCalled()
    const result = await handler!(
      {},
      {
        authInfo: {
          token: 'verified',
          clientId: 'client',
          scopes: [],
          extra: { sub: 'alice', groups: ['developers'], namespaces: ['untrusted'] }
        }
      }
    )

    expect(service.listAccessibleNamespaces).toHaveBeenCalledWith({
      user: 'issuer#alice',
      groups: ['system:authenticated', 'oidc:developers']
    })
    expect(result).toMatchObject({ structuredContent: { namespaces: ['team-a'] } })
  })
})
