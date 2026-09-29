import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it, vi } from 'vitest'
import { registerAccessibleNamespacesTool } from './accessible-namespaces.js'
import type { ToolCallContext } from './caller-scope.js'
import type { RbacScopeResolver } from '../../clients/rbac-scope.js'

const mapping = {
  usernameClaim: 'sub',
  groupsClaim: 'groups',
  usernamePrefix: 'issuer#',
  groupsPrefix: 'oidc:'
}

function register(resolve: ReturnType<typeof vi.fn>) {
  const resolver = { resolve } as unknown as RbacScopeResolver
  let handler: (_input: object, context: ToolCallContext) => Promise<unknown>
  const registerTool = vi.fn((_name, _definition, callback) => {
    handler = callback
  })

  registerAccessibleNamespacesTool({ registerTool } as unknown as McpServer, resolver, mapping)
  expect(registerTool.mock.calls[0][0]).toBe('list_accessible_namespaces')

  return handler!
}

const verified: ToolCallContext = {
  authInfo: {
    token: 'verified',
    clientId: 'client',
    scopes: [],
    extra: { sub: 'alice', groups: ['developers'], namespaces: ['untrusted'] }
  }
}

describe('accessible namespaces tool', () => {
  it('uses only the verified mapped identity and refuses anonymous calls', async () => {
    const resolve = vi.fn().mockResolvedValue({
      namespaces: ['team-a'],
      unknown: [],
      clusterWide: false,
      total: 3,
      truncated: false,
      source: 'rbac'
    })
    const handler = register(resolve)

    await expect(handler({}, {})).rejects.toThrow('authenticated')
    expect(resolve).not.toHaveBeenCalled()
    const result = await handler({}, verified)

    expect(resolve).toHaveBeenCalledWith({
      user: 'issuer#alice',
      groups: ['system:authenticated', 'oidc:developers']
    })
    expect(result).toMatchObject({
      structuredContent: {
        namespaces: ['team-a'],
        clusterWide: false,
        unknown: [],
        truncated: false,
        identity: { user: 'issuer#alice' },
        note: null
      }
    })
  })

  it('explains an empty result as an identity-mapping question rather than an empty cluster', async () => {
    const handler = register(
      vi
        .fn()
        .mockResolvedValue({ namespaces: [], unknown: [], clusterWide: false, total: 3, truncated: false })
    )
    const result = (await handler({}, verified)) as { structuredContent: { note: string } }

    expect(result.structuredContent.note).toContain('KUBERNETES_USERNAME_CLAIM')
    expect(result.structuredContent.note).toContain('issuer#alice')
  })

  it('surfaces cluster-wide access, inconclusive reviews and truncation', async () => {
    const handler = register(
      vi
        .fn()
        .mockResolvedValue({
          namespaces: ['a'],
          unknown: ['b'],
          clusterWide: true,
          total: 5000,
          truncated: true
        })
    )
    const result = (await handler({}, verified)) as { structuredContent: { note: string } }

    expect(result.structuredContent.note).toContain('every namespace')
    expect(result.structuredContent.note).toContain('could not be evaluated')
    expect(result.structuredContent.note).toContain('MCP_SCOPE_MAX_NAMESPACES')
  })
})
