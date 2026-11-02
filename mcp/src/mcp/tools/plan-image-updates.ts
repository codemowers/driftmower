import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ACTIONABLE_VERSION_STATUSES, MANUAL_REVIEW_REASONS } from '../../domain/image-update-plan.js'
import type { ImageUpdatePlanningService } from '../../services/image-update-planning-service.js'
import { resolveCallerScope, scopeNoticeSchema, scopeSuffix, type ScopeDependencies } from './caller-scope.js'
import { READ_ONLY_ANNOTATIONS } from './read-only-annotations.js'

export const PLAN_IMAGE_UPDATES_TOOL_NAME = 'plan_image_updates'

const versionStatusSchema = z.enum(ACTIONABLE_VERSION_STATUSES)
const imageReferenceSchema = z.object({
  reference: z.string(),
  registry: z.string(),
  repository: z.string(),
  tag: z.string().nullable()
})
const workloadIdentitySchema = z.object({
  groupKey: z.string(),
  kind: z.string().nullable(),
  namespace: z.string().nullable(),
  name: z.string().nullable()
})
const imageEvidenceSchema = z.object({
  workload: workloadIdentitySchema,
  containerName: z.string().nullable(),
  currentImage: imageReferenceSchema,
  proposedImage: imageReferenceSchema,
  versionStatus: versionStatusSchema
})
const commonHelmActionSchema = {
  actionId: z.string(),
  versionStatus: versionStatusSchema,
  releaseGroupKey: z.string(),
  releaseName: z.string().nullable(),
  releaseNamespace: z.string().nullable(),
  chartName: z.string().nullable(),
  imageEvidence: z.array(imageEvidenceSchema),
  totalImageCandidates: z.number().int().min(0),
  omittedImageCandidates: z.number().int().min(0)
}
const actionSchema = z.discriminatedUnion('type', [
  z.object({
    actionId: z.string(),
    type: z.literal('image_tag_update'),
    versionStatus: versionStatusSchema,
    workload: workloadIdentitySchema,
    containerName: z.string().nullable(),
    currentImage: imageReferenceSchema,
    proposedImage: imageReferenceSchema
  }),
  z.object({
    ...commonHelmActionSchema,
    type: z.literal('helm_chart_update'),
    observedChartVersion: z.string(),
    latestKnownChartVersion: z.string()
  }),
  z.object({
    ...commonHelmActionSchema,
    type: z.literal('manual_review'),
    reason: z.enum(MANUAL_REVIEW_REASONS),
    observedChartVersion: z.string().nullable(),
    latestKnownChartVersion: z.string().nullable()
  })
])
const inputSchema = {
  namespace: z.string().trim().min(1).optional(),
  versionStatuses: z
    .array(versionStatusSchema)
    .min(1)
    .refine(statuses => new Set(statuses).size === statuses.length, {
      message: 'versionStatuses must be unique'
    })
    .optional(),
  limit: z.number().int().min(1).optional(),
  cursor: z.string().min(1).optional()
}

export const planImageUpdatesOutputSchema = z.object({
  status: z.enum(['ok', 'no_ready_report']),
  filters: z.object({
    namespace: z.string().nullable(),
    versionStatuses: z.array(versionStatusSchema)
  }),
  snapshot: z.object({ reportId: z.string(), createdAt: z.string() }).nullable(),
  summary: z.object({
    uniqueImageCandidates: z.number().int().min(0),
    totalActions: z.number().int().min(0),
    imageTagUpdates: z.number().int().min(0),
    helmChartUpdates: z.number().int().min(0),
    manualReviews: z.number().int().min(0)
  }),
  actions: z.array(actionSchema),
  nextCursor: z.string().nullable(),
  warnings: z.array(z.string()),
  scope: scopeNoticeSchema
})

type PlanImageUpdatesResult = z.infer<typeof planImageUpdatesOutputSchema>

const toolConfiguration = {
  title: 'Plan Driftmower image updates',
  description:
    'Use to propose image-tag and Helm-chart updates from the latest ready Driftmower backend snapshot. Advisory only: does not modify workloads or deploy updates. Inspect snapshot scope, warnings, manual-review actions and nextCursor before presenting a complete plan; verify candidates against live inventory when available.',
  inputSchema,
  outputSchema: planImageUpdatesOutputSchema.shape,
  annotations: READ_ONLY_ANNOTATIONS
}

export function registerPlanImageUpdatesTool(
  server: McpServer,
  planningService: Pick<ImageUpdatePlanningService, 'planImageUpdates'>,
  scopeDependencies?: ScopeDependencies
): void {
  server.registerTool(PLAN_IMAGE_UPDATES_TOOL_NAME, toolConfiguration, async (input, context) => {
    // The scope comes from the verified token, never from `input`: a tool
    // argument is caller-controlled and would be a way to widen access.
    const result = await planningService.planImageUpdates({
      ...input,
      scope: await resolveCallerScope(context, scopeDependencies)
    })

    return {
      structuredContent: { ...result },
      content: [{ type: 'text', text: summarize(result) }]
    }
  })
}

// Leads with the verdict and the counts the plan already computes. The actions
// themselves stay in `structuredContent`; repeating them here as JSON only
// spent the reader's context twice.
function summarize(result: PlanImageUpdatesResult): string {
  if (result.status === 'no_ready_report') {
    return 'No ready Driftmower snapshot, so no update plan could be built.'
  }

  const { summary } = result
  const parts = [
    `${summary.totalActions} advisory action(s) from ${summary.uniqueImageCandidates} image candidate(s): ` +
      `${summary.imageTagUpdates} image tag update(s), ${summary.helmChartUpdates} Helm chart update(s), ` +
      `${summary.manualReviews} needing manual review.`
  ]

  if (result.nextCursor) {
    parts.push('More actions remain; pass `cursor` to continue.')
  }

  if (result.warnings.length > 0) {
    parts.push(`${result.warnings.length} warning(s): ${result.warnings.join('; ')}`)
  }

  return `${parts.join(' ')}${scopeSuffix(result.scope)}`
}
