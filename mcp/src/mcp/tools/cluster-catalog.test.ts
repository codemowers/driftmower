import { describe, expect, it, vi } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolCallContext } from './caller-scope.js'
import { registerClusterCatalogTools } from './cluster-catalog.js'

describe('cluster catalog tools', () => {
  it('requires authentication and exposes both catalogs without namespace claims or SARs', async () => {
    const handlers = new Map<string, (input: object, context: ToolCallContext) => Promise<unknown>>()
    const registerTool = vi.fn((name, _definition, handler) => handlers.set(name, handler))
    const catalog = {
      listStorageClasses: vi
        .fn()
        .mockResolvedValue({ storageClasses: [{ name: 'minio', description: 'Use Bucket CR' }] }),
      listAdmissionPolicies: vi.fn().mockResolvedValue({ policies: [], unavailableKinds: [] })
    }

    registerClusterCatalogTools({ registerTool } as unknown as McpServer, catalog)
    expect([...handlers.keys()]).toEqual(['list_storage_classes', 'list_admission_policies'])
    for (const handler of handlers.values()) await expect(handler({}, {})).rejects.toThrow('authenticated')
    expect(catalog.listStorageClasses).not.toHaveBeenCalled()
    expect(catalog.listAdmissionPolicies).not.toHaveBeenCalled()
    const context = {
      authInfo: { token: 'verified', clientId: 'client', scopes: [], extra: { sub: 'alice' } }
    }

    expect(await handlers.get('list_storage_classes')!({}, context)).toMatchObject({
      structuredContent: { storageClasses: [{ name: 'minio', description: 'Use Bucket CR' }] }
    })
    expect(await handlers.get('list_admission_policies')!({}, context)).toMatchObject({
      content: [{ type: 'text', text: 'name,description,kind,targets,bindings,conditional\n' }]
    })
  })
})
