import { describe, expect, it, vi } from 'vitest'
import type {
  DirectImageUpdateActionGroup,
  HelmImageUpdateActionGroup,
  ImageUpdateActionDetailRow,
  ImageUpdateRepository
} from '../backend/image-update-repository.js'
import type { ReportSnapshotRepository } from '../backend/report-snapshot-repository.js'
import type { ImageUpdatePlanSummary } from '../domain/image-update-plan.js'
import { ImageUpdatePlanningService } from './image-update-planning-service.js'

const SNAPSHOT = {
  reportId: 'report-1',
  clusterContext: 'in-cluster',
  createdAt: '2026-08-01T12:00:00.000Z'
}

const SUMMARY: ImageUpdatePlanSummary = {
  uniqueImageCandidates: 14,
  totalActions: 3,
  imageTagUpdates: 1,
  helmChartUpdates: 1,
  manualReviews: 1
}

describe('ImageUpdatePlanningService', () => {
  it('validates statuses and limits before querying repositories', async () => {
    const imageRepository = createImageRepository()
    const snapshotRepository = createSnapshotRepository()
    const service = new ImageUpdatePlanningService(imageRepository, snapshotRepository, 20, 100)

    await expect(
      service.planImageUpdates({ versionStatuses: ['major_behind', 'major_behind'] })
    ).rejects.toThrow('versionStatuses must contain one or more unique actionable statuses')
    await expect(service.planImageUpdates({ limit: 0 })).rejects.toThrow('limit must be a positive integer')
    expect(snapshotRepository.findLatestReadyInClusterReport).not.toHaveBeenCalled()
  })

  it('returns a bounded no-ready result without querying image actions', async () => {
    const imageRepository = createImageRepository()
    const snapshotRepository = createSnapshotRepository()

    snapshotRepository.findLatestReadyInClusterReport.mockResolvedValue(null)
    const service = new ImageUpdatePlanningService(imageRepository, snapshotRepository, 20, 100)

    const result = await service.planImageUpdates({ namespace: ' apps ' })

    expect(result).toMatchObject({
      status: 'no_ready_report',
      filters: {
        namespace: 'apps',
        versionStatuses: ['major_behind', 'minor_behind', 'patch_behind', 'behind']
      },
      snapshot: null,
      summary: {
        uniqueImageCandidates: 0,
        totalActions: 0,
        imageTagUpdates: 0,
        helmChartUpdates: 0,
        manualReviews: 0
      },
      actions: [],
      nextCursor: null
    })
    expect(result.warnings).toHaveLength(2)
    expect(imageRepository.listActionGroups).not.toHaveBeenCalled()
  })

  it('maps direct, Helm, and manual actions with bounded evidence and stable IDs', async () => {
    const imageRepository = createImageRepository()
    const snapshotRepository = createSnapshotRepository()
    const directGroup = createDirectGroup()
    const helmGroup = createHelmGroup('helm_chart_update', 'helm/apps/chart', 0, 'major_behind')
    const manualGroup = createHelmGroup('manual_review', 'helm/apps/equal', 1, 'minor_behind')
    const details = [
      ...createHelmDetails('helm/apps/chart', 12, {
        name: 'chart',
        namespace: 'apps',
        chartName: 'example-chart',
        chartVersion: 'v1.0.0',
        latestChartTag: '1.1.0'
      }),
      ...createHelmDetails('helm/apps/equal', 1, {
        name: 'equal',
        namespace: 'apps',
        chartName: 'equal-chart',
        chartVersion: 'v2.0.0',
        latestChartTag: '2.0.0'
      })
    ]

    snapshotRepository.findLatestReadyInClusterReport.mockResolvedValue(SNAPSHOT)
    imageRepository.listActionGroups.mockResolvedValue([directGroup, helmGroup, manualGroup])
    imageRepository.loadActionDetails.mockResolvedValue(details)
    imageRepository.summarizeActions.mockResolvedValue(SUMMARY)
    const service = new ImageUpdatePlanningService(imageRepository, snapshotRepository, 20, 100)

    const firstResult = await service.planImageUpdates({})
    const secondResult = await service.planImageUpdates({})

    expect(firstResult).toMatchObject({
      status: 'ok',
      snapshot: { reportId: 'report-1', createdAt: '2026-08-01T12:00:00.000Z' },
      summary: SUMMARY,
      actions: [
        {
          type: 'image_tag_update',
          versionStatus: 'minor_behind',
          workload: { groupKey: 'deployment:apps:api', namespace: 'apps', name: 'api' },
          containerName: 'main',
          currentImage: { reference: 'registry.example/example/api:1.0.0' },
          proposedImage: { reference: 'registry.example/example/api:2.0.0' }
        },
        {
          type: 'helm_chart_update',
          versionStatus: 'major_behind',
          releaseGroupKey: 'helm/apps/chart',
          observedChartVersion: 'v1.0.0',
          latestKnownChartVersion: '1.1.0',
          totalImageCandidates: 12,
          omittedImageCandidates: 2
        },
        {
          type: 'manual_review',
          reason: 'chart_candidate_not_distinct',
          releaseGroupKey: 'helm/apps/equal',
          observedChartVersion: 'v2.0.0',
          latestKnownChartVersion: '2.0.0'
        }
      ],
      nextCursor: null
    })
    expect(
      firstResult.actions[1]?.type === 'helm_chart_update' && firstResult.actions[1].imageEvidence
    ).toHaveLength(10)
    expect(firstResult.actions.map(action => action.actionId)).toEqual(
      secondResult.actions.map(action => action.actionId)
    )
  })

  it('pins later pages to the cursor report when a newer report appears', async () => {
    const imageRepository = createImageRepository()
    const snapshotRepository = createSnapshotRepository()
    const firstGroup = createDirectGroup()
    const lookaheadGroup = createDirectGroup({
      groupKey: '["deployment:apps:worker","main","registry.example","example/worker","1.0.0","2.0.0"]',
      workloadGroupKey: 'deployment:apps:worker',
      workloadName: 'worker',
      repository: 'example/worker'
    })
    const newerSnapshot = {
      reportId: 'report-2',
      clusterContext: 'in-cluster',
      createdAt: '2026-08-02T12:00:00.000Z'
    }

    snapshotRepository.findLatestReadyInClusterReport.mockResolvedValue(SNAPSHOT)
    snapshotRepository.findReadyInClusterReportById.mockResolvedValue(SNAPSHOT)
    imageRepository.listActionGroups
      .mockResolvedValueOnce([firstGroup, lookaheadGroup])
      .mockResolvedValueOnce([lookaheadGroup])
    imageRepository.loadActionDetails.mockResolvedValue([])
    imageRepository.summarizeActions.mockResolvedValue(SUMMARY)
    const service = new ImageUpdatePlanningService(imageRepository, snapshotRepository, 1, 100)

    const firstPage = await service.planImageUpdates({})

    snapshotRepository.findLatestReadyInClusterReport.mockResolvedValue(newerSnapshot)
    const secondPage = await service.planImageUpdates({
      cursor: firstPage.nextCursor ?? undefined
    })

    expect(firstPage.nextCursor).not.toBeNull()
    expect(secondPage).toMatchObject({
      status: 'ok',
      snapshot: { reportId: 'report-1' },
      actions: [{ type: 'image_tag_update', workload: { groupKey: 'deployment:apps:worker' } }]
    })
    expect(snapshotRepository.findReadyInClusterReportById).toHaveBeenCalledWith('report-1')
    expect(imageRepository.listActionGroups).toHaveBeenLastCalledWith(
      expect.objectContaining({ reportId: 'report-1' })
    )
  })
})

function createImageRepository(): ImageUpdateRepository & {
  listActionGroups: ReturnType<typeof vi.fn<ImageUpdateRepository['listActionGroups']>>
  loadActionDetails: ReturnType<typeof vi.fn<ImageUpdateRepository['loadActionDetails']>>
  summarizeActions: ReturnType<typeof vi.fn<ImageUpdateRepository['summarizeActions']>>
} {
  return {
    listActionGroups: vi.fn<ImageUpdateRepository['listActionGroups']>().mockResolvedValue([]),
    loadActionDetails: vi.fn<ImageUpdateRepository['loadActionDetails']>().mockResolvedValue([]),
    summarizeActions: vi.fn<ImageUpdateRepository['summarizeActions']>().mockResolvedValue(SUMMARY)
  }
}

function createSnapshotRepository(): ReportSnapshotRepository & {
  findLatestReadyFullClusterReports: ReturnType<
    typeof vi.fn<ReportSnapshotRepository['findLatestReadyFullClusterReports']>
  >
  findLatestReadyInClusterReport: ReturnType<
    typeof vi.fn<ReportSnapshotRepository['findLatestReadyInClusterReport']>
  >
  findReadyInClusterReportById: ReturnType<
    typeof vi.fn<ReportSnapshotRepository['findReadyInClusterReportById']>
  >
} {
  return {
    findLatestReadyFullClusterReports: vi
      .fn<ReportSnapshotRepository['findLatestReadyFullClusterReports']>()
      .mockResolvedValue([]),
    findLatestReadyInClusterReport: vi
      .fn<ReportSnapshotRepository['findLatestReadyInClusterReport']>()
      .mockResolvedValue(null),
    findReadyInClusterReportById: vi
      .fn<ReportSnapshotRepository['findReadyInClusterReportById']>()
      .mockResolvedValue(null)
  }
}

function createDirectGroup(
  overrides: Partial<DirectImageUpdateActionGroup> = {}
): DirectImageUpdateActionGroup {
  return {
    reportId: 'report-1',
    actionType: 'image_tag_update',
    riskRank: 1,
    versionStatus: 'minor_behind',
    namespace: 'apps',
    groupKey: '["deployment:apps:api","main","registry.example","example/api","1.0.0","2.0.0"]',
    releaseGroupKey: null,
    workloadGroupKey: 'deployment:apps:api',
    workloadKind: 'Deployment',
    workloadNamespace: 'apps',
    workloadName: 'api',
    containerName: 'main',
    registry: 'registry.example',
    repository: 'example/api',
    deployedTag: '1.0.0',
    latestTag: '2.0.0',
    ...overrides
  }
}

function createHelmGroup(
  actionType: HelmImageUpdateActionGroup['actionType'],
  releaseGroupKey: string,
  riskRank: number,
  versionStatus: HelmImageUpdateActionGroup['versionStatus']
): HelmImageUpdateActionGroup {
  return {
    reportId: 'report-1',
    actionType,
    riskRank,
    versionStatus,
    namespace: 'apps',
    groupKey: releaseGroupKey,
    releaseGroupKey,
    workloadGroupKey: null,
    workloadKind: null,
    workloadNamespace: null,
    workloadName: null,
    containerName: null,
    registry: null,
    repository: null,
    deployedTag: null,
    latestTag: null
  }
}

function createHelmDetails(
  releaseGroupKey: string,
  count: number,
  releaseInfo: object
): ImageUpdateActionDetailRow[] {
  return Array.from({ length: count }, (_, index) => ({
    reportId: 'report-1',
    workloadGroupKey: `deployment:apps:workload-${index}`,
    workloadKind: 'Deployment',
    workloadNamespace: 'apps',
    workloadName: `workload-${index}`,
    releaseGroupKey,
    containerName: 'main',
    registry: 'registry.example',
    repository: `example/image-${index}`,
    deployedTag: '1.0.0',
    latestTag: '2.0.0',
    versionStatus: index === 0 ? 'major_behind' : 'minor_behind',
    releaseInfo: JSON.stringify(releaseInfo)
  }))
}
