import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ACTIONABLE_VERSION_STATUSES, MANUAL_REVIEW_REASONS } from '../../domain/image-update-plan.js'
import type { ImageUpdatePlanningService } from '../../services/image-update-planning-service.js'

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
  warnings: z.array(z.string())
})
const toolConfiguration = {
  title: 'Plan Driftmower image updates',
  description:
    'Plan advisory image and Helm chart updates from the latest ready in-cluster Driftmower snapshot.',
  inputSchema,
  outputSchema: planImageUpdatesOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    openWorldHint: false
  }
}

export function registerPlanImageUpdatesTool(
  server: McpServer,
  planningService: Pick<ImageUpdatePlanningService, 'planImageUpdates'>
): void {
  server.registerTool(PLAN_IMAGE_UPDATES_TOOL_NAME, toolConfiguration, async input => {
    const result = await planningService.planImageUpdates(input)

    return {
      structuredContent: { ...result },
      content: [{ type: 'text', text: JSON.stringify(result) }]
    }
  })
}
