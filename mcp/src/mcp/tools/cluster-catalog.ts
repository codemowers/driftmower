import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { storageClassSchema, type ClusterCatalog } from '../../clients/cluster-catalog.js'
import { policyCatalogCsv } from './catalog-summary.js'
import type { ToolCallContext } from './caller-scope.js'
import { omitDefaultFlag } from './catalog-fields.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'

function requireCaller(context: ToolCallContext): void {
  if (typeof context.authInfo?.extra?.sub !== 'string' || !context.authInfo.extra.sub) {
    throw new Error('Cluster catalog requires an authenticated caller')
  }
}

export function registerClusterCatalogTools(server: McpServer, catalog: ClusterCatalog): void {
  server.registerTool(
    'list_storage_classes',
    {
      title: 'List storage classes',
      description:
        'Use to choose storageClassName and understand volume binding, expansion and reclaim behavior. Lists live Kubernetes StorageClasses with provisioning guidance from kubernetes.io/description and structured settings: provisioner, filesystemType, driver parameters, reclaimPolicy, volumeBindingMode, allowVolumeExpansion, mountOptions, and allowedTopologies. Missing descriptions and unspecified filesystem types are null. Cluster-wide capability metadata for authenticated callers.',
      inputSchema: {},
      outputSchema: { storageClasses: z.array(storageClassSchema.omit({ isDefault: true })) },
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (_input, context) => {
      requireCaller(context)
      const catalogResult = await catalog.listStorageClasses()
      const result = { storageClasses: catalogResult.storageClasses.map(omitDefaultFlag) }

      return { structuredContent: result, content: [{ type: 'text', text: JSON.stringify(result) }] }
    }
  )
  server.registerTool(
    'list_admission_policies',
    {
      title: 'List admission policies',
      description:
        'Use before planning resource changes to discover admission requirements and applicable bindings. Returns a CSV catalog of admission policy names, descriptions and target resource rules/selectors, plus binding names and scope restrictions. No policy code is returned. conditional indicates additional conditions or parameters that this summary does not evaluate. bindings=null means discovery is unavailable; [] means no bindings. Match resource rules and binding scope to the intended resource; targets are candidates, not a prediction of effective admission behavior. This catalog does not evaluate policy conditions or replace an authorization check.',
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS
    },
    async (_input, context) => {
      requireCaller(context)
      const result = await catalog.listAdmissionPolicies()

      return { content: [{ type: 'text', text: policyCatalogCsv(result) }] }
    }
  )
}
