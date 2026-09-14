import { beforeAll, describe, expect, it } from 'vitest'
import { BackendReportSnapshotRepository } from '../backend/report-snapshot-repository.js'
import { ReportRowLoader } from '../backend/report-rows.js'
import { BackendWorkloadRepository } from '../backend/workload-repository.js'
import { createFakeBackend } from '../../test/fake-backend.js'
import { WorkloadSearchService } from './workload-search-service.js'

// Drives the service against rows recorded from a real full-cluster analysis,
// served over the same HTTP path production uses.
describe('WorkloadSearchService against recorded backend rows', () => {
  let service: WorkloadSearchService

  beforeAll(() => {
    const { client } = createFakeBackend()
    const reportSnapshotRepository = new BackendReportSnapshotRepository(client)
    const workloadRepository = new BackendWorkloadRepository(
      new ReportRowLoader(client),
      reportSnapshotRepository
    )

    service = new WorkloadSearchService(workloadRepository, 20, 100)
  })

  it('returns persisted image and Helm analysis from a real full-cluster snapshot', async () => {
    const result = await service.searchWorkloads({ query: 'cert-manager', limit: 1 })

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({
      name: 'cert-manager',
      kind: 'Deployment',
      namespace: 'cert-manager',
      analysis: {
        status: 'minor_behind',
        helm: {
          releaseName: 'cert-manager',
          releaseNamespace: 'cert-manager',
          chartName: 'cert-manager',
          observedChartVersion: 'v1.20.0',
          latestKnownChartVersion: '1.21.0',
          appVersion: 'v1.20.0'
        },
        images: [
          {
            registry: 'quay.io',
            repository: 'jetstack/cert-manager-controller',
            observedTag: 'v1.20.0',
            latestKnownTag: 'v1.21.0',
            versionStatus: 'minor_behind'
          }
        ]
      },
      snapshot: {
        reportId: '0b249694-625d-41c8-a788-5b207c9c4d6b',
        createdAt: '2026-07-13 20:14:51'
      }
    })
  })

  it('returns non-Helm analysis and deduplicates repeated pod image usages', async () => {
    const result = await service.searchWorkloads({ query: 'alertmanager', limit: 1 })
    const match = result.matches[0]

    expect(match?.name).toBe('alertmanager')
    expect(match?.analysis.helm).toBeNull()
    expect(match?.analysis.images).toEqual([
      expect.objectContaining({ repository: 'prometheus-operator/prometheus-config-reloader' }),
      expect.objectContaining({ repository: 'prometheus/alertmanager' })
    ])
  })
})
