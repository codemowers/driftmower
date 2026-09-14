import { describe, expect, it } from 'vitest'
import { createFakeBackend } from '../../test/fake-backend.js'
import { BackendReportSnapshotRepository } from './report-snapshot-repository.js'

interface ReportFixture {
  id: string
  clusterContext: string | null
  createdAt: string
  status?: string
  sourceType?: string
  namespaceScope?: unknown
}

const SELECTED_NAMESPACE_SCOPE = { mode: 'selected', namespaces: ['apps'] }

function repositoryWith(reports: ReportFixture[]) {
  const backend = createFakeBackend({
    rows: {
      reports: reports.map(report => ({
        sourceType: 'cluster',
        status: 'ready',
        namespaceScope: { mode: 'all' },
        ...report
      }))
    }
  })

  return { repository: new BackendReportSnapshotRepository(backend.client), backend }
}

describe('BackendReportSnapshotRepository', () => {
  it('selects the latest ready full-cluster report per cluster', async () => {
    const { repository } = repositoryWith([
      { id: 'prod-old', clusterContext: 'prod', createdAt: '2026-01-01' },
      { id: 'prod-ready', clusterContext: 'prod', createdAt: '2026-01-02' },
      { id: 'prod-in-progress', clusterContext: 'prod', createdAt: '2026-01-03', status: 'in_progress' },
      { id: 'prod-scoped', clusterContext: 'prod', createdAt: '2026-01-04', namespaceScope: SELECTED_NAMESPACE_SCOPE },
      { id: 'prod-yaml', clusterContext: 'prod', createdAt: '2026-01-05', sourceType: 'yaml' },
      { id: 'staging-ready', clusterContext: 'staging', createdAt: '2026-01-01' }
    ])

    await expect(repository.findLatestReadyFullClusterReports()).resolves.toEqual([
      { reportId: 'prod-ready', clusterContext: 'prod', createdAt: '2026-01-02' },
      { reportId: 'staging-ready', clusterContext: 'staging', createdAt: '2026-01-01' }
    ])
  })

  it('asks the backend to do the filtering it can do', async () => {
    const { repository, backend } = repositoryWith([
      { id: 'prod-ready', clusterContext: 'prod', createdAt: '2026-01-02' }
    ])

    await repository.findLatestReadyFullClusterReports('prod')

    const request = decodeURIComponent(backend.requests[0])

    expect(request).toContain('sourceType=cluster')
    expect(request).toContain('status=ready')
    expect(request).toContain('clusterContext=prod')
    // Selecting is what stops the backend assembling every report it returns.
    expect(request).toContain('$select[0]=id')
  })

  it('filters by exact cluster context', async () => {
    const { repository } = repositoryWith([
      { id: 'prod-ready', clusterContext: 'prod', createdAt: '2026-01-02' },
      { id: 'staging-ready', clusterContext: 'staging', createdAt: '2026-01-03' }
    ])

    await expect(repository.findLatestReadyFullClusterReports('staging')).resolves.toEqual([
      { reportId: 'staging-ready', clusterContext: 'staging', createdAt: '2026-01-03' }
    ])
  })

  it('uses report id as the deterministic tie breaker', async () => {
    const { repository } = repositoryWith([
      { id: 'report-a', clusterContext: 'prod', createdAt: '2026-01-02' },
      { id: 'report-b', clusterContext: 'prod', createdAt: '2026-01-02' }
    ])

    await expect(repository.findLatestReadyFullClusterReports()).resolves.toMatchObject([
      { reportId: 'report-b' }
    ])
  })

  it('returns no snapshot when the cluster has no ready report', async () => {
    const { repository } = repositoryWith([
      { id: 'prod-pending', clusterContext: 'prod', createdAt: '2026-01-02', status: 'pending' }
    ])

    await expect(repository.findLatestReadyFullClusterReports()).resolves.toEqual([])
    await expect(repository.findLatestReadyInClusterReport()).resolves.toBeNull()
  })

  it('selects only the latest eligible in-cluster report', async () => {
    const { repository } = repositoryWith([
      { id: 'in-cluster-old', clusterContext: 'in-cluster', createdAt: '2026-01-01' },
      { id: 'in-cluster-new', clusterContext: 'in-cluster', createdAt: '2026-01-02' },
      { id: 'remote', clusterContext: 'prod', createdAt: '2026-01-03' }
    ])

    await expect(repository.findLatestReadyInClusterReport()).resolves.toEqual({
      reportId: 'in-cluster-new',
      clusterContext: 'in-cluster',
      createdAt: '2026-01-02'
    })
  })

  it('loads an older cursor-pinned report only while it remains eligible', async () => {
    const { repository } = repositoryWith([
      { id: 'pinned', clusterContext: 'in-cluster', createdAt: '2026-01-01' },
      { id: 'newer', clusterContext: 'in-cluster', createdAt: '2026-01-02' },
      { id: 'scoped', clusterContext: 'in-cluster', createdAt: '2026-01-03', namespaceScope: SELECTED_NAMESPACE_SCOPE },
      { id: 'remote', clusterContext: 'prod', createdAt: '2026-01-04' }
    ])

    await expect(repository.findReadyInClusterReportById('pinned')).resolves.toMatchObject({
      reportId: 'pinned'
    })
    // A pinned report that is namespace-scoped or from another cluster is not
    // the snapshot this cursor was issued against.
    await expect(repository.findReadyInClusterReportById('scoped')).resolves.toBeNull()
    await expect(repository.findReadyInClusterReportById('remote')).resolves.toBeNull()
    await expect(repository.findReadyInClusterReportById('missing')).resolves.toBeNull()
  })
})
