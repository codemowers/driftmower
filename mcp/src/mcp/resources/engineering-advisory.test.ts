import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createMcpServer } from '../create-server.js'

describe('engineering advisory over MCP', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const close of cleanup.splice(0)) await close()
  })

  async function connect() {
    const server = createMcpServer({})
    const client = new Client({ name: 'advisory-test', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    await server.connect(serverTransport)
    await client.connect(clientTransport)
    cleanup.push(async () => {
      await client.close()
      await server.close()
    })

    return client
  }

  it('discovers and reads every section without backend services', async () => {
    const client = await connect()
    const { resources } = await client.listResources()

    expect(resources.length).toBeGreaterThan(0)
    expect(new Set(resources.map(resource => resource.uri)).size).toBe(resources.length)
    for (const resource of resources) {
      expect(resource.mimeType).toBe('text/markdown')
      const result = await client.readResource({ uri: resource.uri })
      const { text } = z.object({ text: z.string() }).parse(result.contents[0])

      expect(result.contents[0]).toMatchObject({ uri: resource.uri, mimeType: 'text/markdown' })
      expect(text).toEqual(expect.stringMatching(/^# /))
    }
  })

  it('returns an index by default and the same content through resources and the lookup tool', async () => {
    const client = await connect()
    const index = await client.callTool({ name: 'get_engineering_advisory', arguments: {} })

    expect(index.isError).toBeFalsy()
    expect(index.structuredContent).toMatchObject({ path: 'index' })
    const path = 'building/languages/python'
    const result = await client.callTool({ name: 'get_engineering_advisory', arguments: { path } })
    const resource = await client.readResource({ uri: `engineering://advisory/${path}` })
    const { markdown } = z.object({ markdown: z.string() }).parse(result.structuredContent)
    const { text } = z.object({ text: z.string() }).parse(resource.contents[0])

    expect(markdown).toBe(text)
    expect(result.structuredContent).not.toHaveProperty('sourceUrl')
  })

  it('rejects unknown paths', async () => {
    const client = await connect()

    const invalid = await client.callTool({
      name: 'get_engineering_advisory',
      arguments: { path: '../../etc/passwd' }
    })

    expect(invalid.isError).toBe(true)
    await expect(client.readResource({ uri: 'engineering://advisory/nonexistent' })).rejects.toThrow()
  })
})
