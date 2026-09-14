import { describe, expect, it } from 'vitest'
import { createFakeBackend } from '../../test/fake-backend.js'
import {
  BackendImageUpdateRepository,
  type ImageUpdateRepositoryFilters
} from './image-update-repository.js'
import { ReportRowLoader } from './report-rows.js'

const REPORT_ID = 'report-1'

interface UsageInput {
  workloadGroupKey: string
  workloadNamespace?: string
  releaseGroupKey?: string | null
  containerName?: string | null
  repository?: string
  deployedTag?: string | null
  latestTag?: string | null
  versionStatus?: string | null
}

function usage(input: UsageInput): Record<string, unknown> {
  return {
    reportId: REPORT_ID,
    workloadGroupKey: input.workloadGroupKey,
    workloadKind: 'Deployment',
    workloadNamespace: input.workloadNamespace ?? 'apps',
    workloadName: input.workloadGroupKey.split(':').at(-1),
    releaseGroupKey: input.releaseGroupKey ?? null,
    containerName: input.containerName === undefined ? 'main' : input.containerName,
    registry: 'registry.example',
    repository: input.repository ?? 'example/api',
    deployedTag: input.deployedTag === undefined ? '1.0.0' : input.deployedTag,
    latestTag: input.latestTag === undefined ? '2.0.0' : input.latestTag,
    status: 'outdated',
    versionStatus: input.versionStatus ?? null
  }
}

function release(groupKey: string, releaseInfo: object): Record<string, unknown> {
  return { reportId: REPORT_ID, groupKey, releaseInfo: JSON.stringify(releaseInfo) }
}

function filters(): ImageUpdateRepositoryFilters {
  return {
    reportId: REPORT_ID,
    namespace: null,
    versionStatuses: ['major_behind', 'minor_behind', 'patch_behind', 'behind'],
    allowedNamespaces: null
  }
}

function createRepository(
  imageUsages: Array<Record<string, unknown>>,
  releaseScores: Array<Record<string, unknown>> = []
): BackendImageUpdateRepository {
  const { client } = createFakeBackend({
    rows: { 'image-usages': imageUsages, 'release-scores': releaseScores }
  })

  return new BackendImageUpdateRepository(new ReportRowLoader(client))
}

describe('BackendImageUpdateRepository', () => {
  it('deduplicates direct replicas and preserves distinct containers', async () => {
    const repository = createRepository([
      usage({ workloadGroupKey: 'deployment:apps:api', versionStatus: 'minor_behind' }),
      usage({ workloadGroupKey: 'deployment:apps:api', versionStatus: 'minor_behind' }),
      usage({
        workloadGroupKey: 'deployment:apps:api',
        containerName: 'sidecar',
        repository: 'example/sidecar',
        versionStatus: 'patch_behind'
      }),
      usage({
        workloadGroupKey: 'deployment:apps:ignored',
        latestTag: null,
        versionStatus: 'major_behind'
      }),
      usage({ workloadGroupKey: 'deployment:apps:current', versionStatus: 'up_to_date' })
    ])
    const groups = await repository.listActionGroups({ ...filters(), after: null, limit: 20 })
    const summary = await repository.summarizeActions(filters())
    const details = await repository.loadActionDetails({ ...filters(), groups })

    expect(groups).toHaveLength(2)
    expect(groups).toMatchObject([
      {
        actionType: 'image_tag_update',
        versionStatus: 'minor_behind',
        workloadGroupKey: 'deployment:apps:api',
        containerName: 'main'
      },
      {
        actionType: 'image_tag_update',
        versionStatus: 'patch_behind',
        workloadGroupKey: 'deployment:apps:api',
        containerName: 'sidecar'
      }
    ])
    expect(summary).toMatchObject({
      uniqueImageCandidates: 2,
      totalActions: 2,
      imageTagUpdates: 2,
      helmChartUpdates: 0,
      manualReviews: 0
    })
    // Both replicas of the deduplicated group keep their detail rows.
    expect(details).toHaveLength(3)
  })

  it('consolidates Helm releases and classifies chart candidates', async () => {
    const repository = createRepository(
      [
        usage({
          workloadGroupKey: 'deployment:apps:chart',
          releaseGroupKey: 'helm/apps/chart',
          versionStatus: 'patch_behind'
        }),
        usage({
          workloadGroupKey: 'deployment:apps:chart-worker',
          releaseGroupKey: 'helm/apps/chart',
          repository: 'example/worker',
          versionStatus: 'major_behind'
        }),
        usage({
          workloadGroupKey: 'deployment:apps:equal',
          releaseGroupKey: 'helm/apps/equal',
          versionStatus: 'minor_behind'
        }),
        usage({
          workloadGroupKey: 'deployment:other:missing',
          workloadNamespace: 'other',
          releaseGroupKey: 'helm/other/missing',
          versionStatus: 'behind'
        })
      ],
      [
        release('helm/apps/chart', {
          name: 'chart',
          namespace: 'apps',
          chartName: 'example-chart',
          chartVersion: 'v1.0.0',
          latestChartTag: '1.1.0'
        }),
        // Same version written two ways: nothing to update.
        release('helm/apps/equal', { name: 'equal', namespace: 'apps', chartVersion: 'v2.0.0', latestChartTag: '2.0.0' }),
        // No candidate at all: a human has to decide what to do.
        release('helm/other/missing', { name: 'missing', namespace: 'other', chartVersion: '3.0.0' })
      ]
    )
    const groups = await repository.listActionGroups({ ...filters(), after: null, limit: 20 })
    const summary = await repository.summarizeActions(filters())
    const appsSummary = await repository.summarizeActions({ ...filters(), namespace: 'apps' })

    expect(groups).toMatchObject([
      {
        actionType: 'helm_chart_update',
        releaseGroupKey: 'helm/apps/chart',
        // The riskiest image in the release decides the release's risk.
        versionStatus: 'major_behind'
      },
      {
        actionType: 'manual_review',
        releaseGroupKey: 'helm/apps/equal',
        versionStatus: 'minor_behind'
      },
      {
        actionType: 'manual_review',
        releaseGroupKey: 'helm/other/missing',
        versionStatus: 'behind'
      }
    ])
    expect(summary).toMatchObject({
      uniqueImageCandidates: 4,
      totalActions: 3,
      imageTagUpdates: 0,
      helmChartUpdates: 1,
      manualReviews: 2
    })
    expect(appsSummary).toMatchObject({
      uniqueImageCandidates: 3,
      totalActions: 2,
      helmChartUpdates: 1,
      manualReviews: 1
    })
  })

  it('continues after the complete stable sort key', async () => {
    const repository = createRepository([
      usage({
        workloadGroupKey: 'deployment:apps:alpha',
        repository: 'example/alpha',
        versionStatus: 'minor_behind'
      }),
      usage({
        workloadGroupKey: 'deployment:apps:beta',
        repository: 'example/beta',
        versionStatus: 'minor_behind'
      }),
      usage({
        workloadGroupKey: 'deployment:apps:gamma',
        repository: 'example/gamma',
        versionStatus: 'patch_behind'
      })
    ])
    const firstPage = await repository.listActionGroups({ ...filters(), after: null, limit: 2 })
    const lastGroup = firstPage[1]!
    const secondPage = await repository.listActionGroups({
      ...filters(),
      after: {
        riskRank: lastGroup.riskRank,
        actionType: lastGroup.actionType,
        namespace: lastGroup.namespace,
        groupKey: lastGroup.groupKey
      },
      limit: 2
    })

    expect(firstPage).toHaveLength(2)
    expect(secondPage).toHaveLength(1)
    expect(secondPage[0]).toMatchObject({
      workloadGroupKey: 'deployment:apps:gamma',
      versionStatus: 'patch_behind'
    })
  })

  it('reads each report once however many questions are asked of it', async () => {
    const { client, requests } = createFakeBackend({
      rows: {
        'image-usages': [usage({ workloadGroupKey: 'deployment:apps:api', versionStatus: 'behind' })],
        'release-scores': []
      }
    })
    const repository = new BackendImageUpdateRepository(new ReportRowLoader(client))

    await repository.listActionGroups({ ...filters(), after: null, limit: 20 })
    await repository.summarizeActions(filters())

    // A ready report is immutable, so listing and summarising share one read
    // instead of paging the whole report twice.
    expect(requests.filter(request => request.startsWith('/image-usages'))).toHaveLength(1)
  })
})
