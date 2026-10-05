import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it, vi } from 'vitest'
import { registerListPodsTool } from './list-pods.js'

async function setup(authenticated = true, grant = true) {
  const allowed = vi.fn(async () => grant)
  const read = vi.fn(async (path: string) =>
    JSON.stringify(
      path.includes('continue=')
        ? { items: [{ metadata: { name: 'a' }, spec: { private: 'not exported' } }] }
        : { metadata: { continue: 'page/2' }, items: [{ metadata: { name: 'z' } }] }
    )
  )
  const server = new McpServer({ name: 'test', version: '1' })

  registerListPodsTool(
    server,
    { allowed, read },
    { usernameClaim: 'sub', groupsClaim: 'groups', usernamePrefix: 'issuer#', groupsPrefix: '' }
  )
  const client = new Client({ name: 'test', version: '1' })
  const [ct, st] = InMemoryTransport.createLinkedPair()

  await server.connect(st)
  const handler = st.onmessage!

  st.onmessage = (message, extra) =>
    handler(message, {
      ...extra,
      ...(authenticated
        ? { authInfo: { token: 'verified', clientId: 'test', scopes: [], extra: { sub: 'alice' } } }
        : {})
    })
  await client.connect(ct)

  return { client, server, allowed, read }
}

describe('pod name listing', () => {
  it('checks namespace RBAC, requests metadata, follows pages and exports only sorted names', async () => {
    const { client, server, allowed, read } = await setup()

    try {
      const result = await client.callTool({ name: 'list_pods', arguments: { namespace: 'team-a' } })

      expect(allowed).toHaveBeenCalledWith(
        { user: 'issuer#alice', groups: ['system:authenticated'] },
        { namespace: 'team-a', group: '', resource: 'pods', verb: 'list' }
      )
      expect(result.structuredContent).toEqual({ namespace: 'team-a', pods: ['a', 'z'] })
      expect(read).toHaveBeenCalledWith(
        '/api/v1/namespaces/team-a/pods?limit=200&continue=page%2F2',
        expect.stringContaining('PartialObjectMetadataList')
      )
      expect(JSON.stringify(result)).not.toContain('not exported')
    } finally {
      await client.close()
      await server.close()
    }
  })
  it.each([
    [false, true],
    [true, false]
  ])('refuses unauthorized callers without reading pods (%s, %s)', async (authenticated, grant) => {
    const { client, server, read } = await setup(authenticated, grant)

    try {
      expect((await client.callTool({ name: 'list_pods', arguments: { namespace: 'team-a' } })).isError).toBe(
        true
      )
      expect(read).not.toHaveBeenCalled()
    } finally {
      await client.close()
      await server.close()
    }
  })
})
