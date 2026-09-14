import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { SearchWorkloadsResult } from '../../domain/workload-result.js'
import type { WorkloadSearchService } from '../../services/workload-search-service.js'
import { callerScope, scopeNoticeSchema, scopeSuffix } from './caller-scope.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'

export const SEARCH_WORKLOADS_TOOL_NAME = 'search_workloads'

// How many matches the text summary names before it stops and counts the rest.
// The full list is always in `structuredContent`; this is what a reader skims.
const NAMED_IN_SUMMARY = 5

const imageAnalysisSchema = z.object({
  registry: z.string(),
  repository: z.string(),
  observedTag: z.string().nullable(),
  latestKnownTag: z.string().nullable(),
  status: z.string().nullable(),
  versionStatus: z.string().nullable()
})

const helmAnalysisSchema = z.object({
  releaseName: z.string().nullable(),
  releaseNamespace: z.string().nullable(),
  chartName: z.string().nullable(),
  observedChartVersion: z.string().nullable(),
  latestKnownChartVersion: z.string().nullable(),
  appVersion: z.string().nullable()
})

const workloadMatchSchema = z.object({
  workloadId: z.string(),
  name: z.string().nullable(),
  kind: z.string().nullable(),
  cluster: z.string().nullable(),
  namespace: z.string().nullable(),
  analysis: z.object({
    status: z.string().nullable(),
    helm: helmAnalysisSchema.nullable(),
    images: z.array(imageAnalysisSchema)
  }),
  snapshot: z.object({ reportId: z.string(), createdAt: z.string() })
})

// Declared so a client can rely on `structuredContent` instead of parsing the
// text block. Without it the SDK advertises no output shape and a strict client
// has to fall back to the prose, which is why this tool used to ship the whole
// result as JSON in `content` as well.
const outputSchema = {
  query: z.string(),
  matches: z.array(workloadMatchSchema),
  scope: scopeNoticeSchema
}

export function registerSearchWorkloadsTool(
  server: McpServer,
  workloadSearchService: Pick<WorkloadSearchService, 'searchWorkloads'>
): void {
  server.registerTool(
    SEARCH_WORKLOADS_TOOL_NAME,
    {
      title: 'Search Driftmower workloads',
      description: 'Find workloads by name in latest full-cluster Driftmower report snapshots.',
      inputSchema: {
        query: z.string().trim().min(1),
        limit: z.number().int().min(1).optional()
      },
      outputSchema,
      annotations: READ_ONLY_ANNOTATIONS
    },
    async ({ query, limit }, context) => {
      const result = await workloadSearchService.searchWorkloads({
        query,
        limit,
        scope: callerScope(context)
      })

      return {
        structuredContent: { ...result },
        content: [{ type: 'text', text: summarize(result) }]
      }
    }
  )
}

// Leads with the verdict and a count, then names real objects so the line is
// greppable. The matches themselves stay in `structuredContent`.
function summarize(result: SearchWorkloadsResult): string {
  const { matches, query, scope } = result

  if (matches.length === 0) {
    return `No workloads match \`${query}\`.${scopeSuffix(scope)}`
  }

  const named = matches
    .slice(0, NAMED_IN_SUMMARY)
    .map(match => `${match.namespace ?? 'unknown'}/${match.name ?? match.workloadId}`)
    .join(', ')
  const remaining = matches.length - Math.min(matches.length, NAMED_IN_SUMMARY)
  const more = remaining > 0 ? ` and ${remaining} more` : ''

  return `${matches.length} workload(s) match \`${query}\`: ${named}${more}.${scopeSuffix(scope)}`
}
