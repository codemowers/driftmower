import { describe, expect, it } from 'vitest'
import { createFakeBackend } from '../../test/fake-backend.js'
import { BackendReportSnapshotRepository } from './report-snapshot-repository.js'
import { ReportRowLoader } from './report-rows.js'
import { BackendWorkloadRepository } from './workload-repository.js'

const ALL_NAMESPACES = { mode: 'all' }
const SELECTED_NAMESPACES = { mode: 'selected', namespaces: ['apps'] }

type Row = Record<string, unknown>

function report(
  id: string,
  cluster: string,
  createdAt: string,
  sourceType = 'cluster',
  namespaceScope: unknown = ALL_NAMESPACES,
  status = 'ready'
): Row {
  return { id, clusterContext: cluster, createdAt, sourceType, namespaceScope, status }
}

function usage(
  reportId: string,
  groupKey: string,
  workloadName: string,
  repository = 'example/workload',
  containerName = 'main',
  releaseGroupKey: string | null = null,
  workloadNamespace = 'apps'
): Row {
  return {
    reportId,
    workloadGroupKey: groupKey,
    workloadKind: 'Deployment',
    workloadNamespace,
    workloadName,
    releaseGroupKey,
    registry: 'registry.example',
    repository,
    deployedTag: '1.0.0',
    latestTag: '2.0.0',
    status: 'analyzed',
    versionStatus: 'outdated',
    containerName
  }
}

function release(reportId: string, groupKey: string, releaseInfo: object): Row {
  return { reportId, groupKey, releaseInfo: JSON.stringify(releaseInfo) }
}

function createRepository(
  reports: Row[],
  imageUsages: Row[],
  releaseScores: Row[] = []
): BackendWorkloadRepository {
  const { client } = createFakeBackend({
    rows: { reports, 'image-usages': imageUsages, 'release-scores': releaseScores }
  })

  return new BackendWorkloadRepository(
    new ReportRowLoader(client),
    new BackendReportSnapshotRepository(client)
  )
}

describe('BackendWorkloadRepository', () => {
  it('searches only the latest ready full-cluster report per cluster', async () => {
    const repository = createRepository(
      [
        report('old-full', 'prod', '2026-01-01'),
        report('latest-full', 'prod', '2026-01-02', 'cluster', ALL_NAMESPACES, 'pending'),
        report('newer-selected', 'prod', '2026-01-03', 'cluster', SELECTED_NAMESPACES),
        report('newest-yaml', 'prod', '2026-01-04', 'yaml'),
        report('stage-full', 'stage', '2026-01-02')
      ],
      [
        usage('old-full', 'old', 'memelord-old'),
        usage('latest-full', 'prod', 'Memelord'),
        usage('newer-selected', 'selected', 'memelord-selected'),
        usage('newest-yaml', 'yaml', 'memelord-yaml'),
        usage('stage-full', 'stage', 'memelord-stage')
      ]
    )
    const groups = await repository.searchMatchingGroups('MEMELORD', 20)

    expect(groups).toHaveLength(2)
    expect(groups.map(group => group.reportId)).toEqual(['old-full', 'stage-full'])
    expect(groups[0]).toMatchObject({
      clusterContext: 'prod',
      reportCreatedAt: '2026-01-01',
      workloadName: 'memelord-old',
      matchRank: 1
    })
  })

  it('ranks exact, prefix, and substring matches deterministically', async () => {
    const repository = createRepository(
      [report('report', 'prod', '2026-01-01')],
      [
        usage('report', 'substring', 'our-api-worker'),
        usage('report', 'prefix', 'api-worker'),
        usage('report', 'exact', 'API')
      ]
    )
    const groups = await repository.searchMatchingGroups('api', 20)

    expect(groups.map(group => [group.workloadName, group.matchRank])).toEqual([
      ['API', 0],
      ['api-worker', 1],
      ['our-api-worker', 2]
    ])
  })

  it('searches namespace and image repository when workload name does not match', async () => {
    const repository = createRepository(
      [report('report', 'prod', '2026-01-01')],
      [
        usage('report', 'namespace', 'llama-gemma', 'ggml-org/llama.cpp', 'main', null, 'llm'),
        usage('report', 'repository', 'webui', 'open-webui/open-webui')
      ]
    )
    const namespaceMatches = await repository.searchMatchingGroups('llm', 20)
    const repositoryMatches = await repository.searchMatchingGroups('open-webui', 20)

    expect(namespaceMatches).toHaveLength(1)
    expect(namespaceMatches[0]).toMatchObject({
      workloadName: 'llama-gemma',
      workloadNamespace: 'llm',
      matchRank: 3
    })
    expect(repositoryMatches).toHaveLength(1)
    expect(repositoryMatches[0]).toMatchObject({
      workloadName: 'webui',
      workloadNamespace: 'apps',
      matchRank: 10
    })
  })

  it('searches persisted Helm release and chart metadata', async () => {
    const repository = createRepository(
      [report('report', 'prod', '2026-01-01')],
      [usage('report', 'helm', 'controller', 'example/controller', 'main', 'release-1')],
      [
        release('report', 'release-1', {
          name: 'cert-manager',
          namespace: 'cert-manager',
          chartName: 'cert-manager-chart'
        })
      ]
    )
    const chartMatches = await repository.searchMatchingGroups('cert-manager-chart', 20)
    const releaseMatches = await repository.searchMatchingGroups('cert-manager', 20)

    expect(chartMatches).toHaveLength(1)
    expect(chartMatches[0]).toMatchObject({
      workloadName: 'controller',
      releaseInfo: expect.stringContaining('cert-manager-chart'),
      matchRank: 12
    })
    expect(releaseMatches).toHaveLength(1)
    expect(releaseMatches[0]).toMatchObject({
      workloadName: 'controller',
      releaseInfo: expect.stringContaining('cert-manager'),
      matchRank: 12
    })
  })

  it('limits workload groups rather than image rows', async () => {
    const repository = createRepository(
      [report('report', 'prod', '2026-01-01')],
      [
        usage('report', 'alpha', 'api-alpha', 'api/alpha', 'main'),
        usage('report', 'alpha', 'api-alpha', 'api/sidecar', 'sidecar'),
        usage('report', 'beta', 'api-beta', 'api/beta', 'main')
      ]
    )
    const groups = await repository.searchMatchingGroups('api', 1)
    const details = await repository.loadWorkloadDetails(groups)

    expect(groups).toHaveLength(1)
    expect(details).toHaveLength(2)
    expect(details.map(detail => detail.repository)).toEqual(['api/alpha', 'api/sidecar'])
  })

  it('joins release analysis while retaining non-Helm image rows', async () => {
    const repository = createRepository(
      [report('report', 'prod', '2026-01-01')],
      [
        usage('report', 'helm', 'helm-api', 'api/helm', 'main', 'release-1'),
        usage('report', 'plain', 'plain-api', 'api/plain', 'main')
      ],
      [release('report', 'release-1', { chartName: 'api' })]
    )
    const groups = await repository.searchMatchingGroups('api', 20)
    const details = await repository.loadWorkloadDetails(groups)

    expect(details).toHaveLength(2)
    expect(details.find(detail => detail.workloadGroupKey === 'helm')).toMatchObject({
      releaseGroupKey: 'release-1',
      releaseInfo: JSON.stringify({ chartName: 'api' })
    })
    expect(details.find(detail => detail.workloadGroupKey === 'plain')).toMatchObject({
      releaseGroupKey: null,
      releaseInfo: null
    })
  })

  it('reads a report once across search and detail loading', async () => {
    const { client, requests } = createFakeBackend({
      rows: {
        reports: [report('report', 'prod', '2026-01-01')],
        'image-usages': [usage('report', 'alpha', 'api-alpha')],
        'release-scores': []
      }
    })
    const repository = new BackendWorkloadRepository(
      new ReportRowLoader(client),
      new BackendReportSnapshotRepository(client)
    )

    const groups = await repository.searchMatchingGroups('api', 20)

    await repository.loadWorkloadDetails(groups)

    expect(requests.filter(request => request.startsWith('/image-usages'))).toHaveLength(1)
  })
})
