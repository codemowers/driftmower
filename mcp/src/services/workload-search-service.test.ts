import { describe, expect, it, vi } from 'vitest'
import type {
  MatchingWorkloadGroupRow,
  WorkloadDetailRow,
  WorkloadRepository
} from '../db/workload-repository.js'
import { WorkloadSearchService } from './workload-search-service.js'

describe('WorkloadSearchService', () => {
  it('rejects an empty query without calling the repository', async () => {
    const repository = createRepository()
    const service = new WorkloadSearchService(repository, 20, 100)

    await expect(service.searchWorkloads({ query: '   ' })).rejects.toThrow(
      'query must be a non-empty string'
    )
    expect(repository.searchMatchingGroups).not.toHaveBeenCalled()
  })

  it('trims the query, uses the default limit, and clamps an explicit limit', async () => {
    const repository = createRepository()
    const service = new WorkloadSearchService(repository, 20, 100)

    await service.searchWorkloads({ query: ' api ' })
    await service.searchWorkloads({ query: 'api', limit: 500 })

    expect(repository.searchMatchingGroups).toHaveBeenNthCalledWith(1, 'api', 20)
    expect(repository.searchMatchingGroups).toHaveBeenNthCalledWith(2, 'api', 100)
  })

  it('groups image rows, deduplicates them, and maps persisted fields', async () => {
    const group = createGroup()
    const firstImage = createDetail(group, {
      repository: 'example/api',
      deployedTag: null,
      latestTag: '2.0.0',
      versionStatus: 'current'
    })
    const outdatedImage = createDetail(group, {
      repository: 'example/sidecar',
      deployedTag: '1.0.0',
      latestTag: '1.1.0',
      versionStatus: 'outdated'
    })
    const repository = createRepository([group], [outdatedImage, firstImage, firstImage])
    const service = new WorkloadSearchService(repository, 20, 100)

    const result = await service.searchWorkloads({ query: 'api' })

    expect(result).toEqual({
      query: 'api',
      matches: [
        {
          workloadId: 'deployment:apps:api',
          name: 'api',
          kind: 'Deployment',
          cluster: 'prod',
          namespace: 'apps',
          analysis: {
            status: 'outdated',
            helm: null,
            images: [
              {
                registry: 'registry.example',
                repository: 'example/api',
                observedTag: null,
                latestKnownTag: '2.0.0',
                status: 'analyzed',
                versionStatus: 'current'
              },
              {
                registry: 'registry.example',
                repository: 'example/sidecar',
                observedTag: '1.0.0',
                latestKnownTag: '1.1.0',
                status: 'analyzed',
                versionStatus: 'outdated'
              }
            ]
          },
          snapshot: {
            reportId: 'report-1',
            createdAt: '2026-07-15T12:00:00.000Z'
          }
        }
      ]
    })
  })

  it('maps valid Helm release JSON and ignores malformed JSON', async () => {
    const helmGroup = createGroup({ workloadGroupKey: 'helm', workloadName: 'helm-api' })
    const malformedGroup = createGroup({ workloadGroupKey: 'broken', workloadName: 'broken-api' })
    const repository = createRepository(
      [helmGroup, malformedGroup],
      [
        createDetail(helmGroup, {
          releaseGroupKey: 'release-1',
          releaseInfo: JSON.stringify({
            name: 'api-release',
            namespace: 'apps',
            chartName: 'api-chart',
            chartVersion: '1.2.3',
            latestChartTag: '1.3.0',
            chartAppVersion: '4.5.6'
          })
        }),
        createDetail(malformedGroup, {
          releaseGroupKey: 'release-2',
          releaseInfo: '{not-json'
        })
      ]
    )
    const service = new WorkloadSearchService(repository, 20, 100)

    const result = await service.searchWorkloads({ query: 'api' })

    expect(result.matches[0]?.analysis.helm).toEqual({
      releaseName: 'api-release',
      releaseNamespace: 'apps',
      chartName: 'api-chart',
      observedChartVersion: '1.2.3',
      latestKnownChartVersion: '1.3.0',
      appVersion: '4.5.6'
    })
    expect(result.matches[1]?.analysis.helm).toBeNull()
  })

  it('rejects non-positive and fractional limits', async () => {
    const service = new WorkloadSearchService(createRepository(), 20, 100)

    await expect(service.searchWorkloads({ query: 'api', limit: 0 })).rejects.toThrow(
      'limit must be a positive integer'
    )
    await expect(service.searchWorkloads({ query: 'api', limit: 1.5 })).rejects.toThrow(
      'limit must be a positive integer'
    )
  })
})

function createRepository(
  groups: MatchingWorkloadGroupRow[] = [],
  details: WorkloadDetailRow[] = []
): WorkloadRepository & {
  searchMatchingGroups: ReturnType<typeof vi.fn<WorkloadRepository['searchMatchingGroups']>>
  loadWorkloadDetails: ReturnType<typeof vi.fn<WorkloadRepository['loadWorkloadDetails']>>
} {
  return {
    searchMatchingGroups: vi.fn<WorkloadRepository['searchMatchingGroups']>().mockResolvedValue(groups),
    loadWorkloadDetails: vi.fn<WorkloadRepository['loadWorkloadDetails']>().mockResolvedValue(details)
  }
}

function createGroup(overrides: Partial<MatchingWorkloadGroupRow> = {}): MatchingWorkloadGroupRow {
  return {
    reportId: 'report-1',
    clusterContext: 'prod',
    reportCreatedAt: '2026-07-15T12:00:00.000Z',
    workloadGroupKey: 'deployment:apps:api',
    workloadKind: 'Deployment',
    workloadNamespace: 'apps',
    workloadName: 'api',
    searchRepository: null,
    releaseInfo: null,
    matchRank: 0,
    ...overrides
  }
}

function createDetail(
  group: MatchingWorkloadGroupRow,
  overrides: Partial<WorkloadDetailRow> = {}
): WorkloadDetailRow {
  return {
    ...group,
    releaseGroupKey: null,
    registry: 'registry.example',
    repository: 'example/api',
    deployedTag: '1.0.0',
    latestTag: '2.0.0',
    imageStatus: 'analyzed',
    versionStatus: 'outdated',
    releaseInfo: null,
    ...overrides
  }
}
