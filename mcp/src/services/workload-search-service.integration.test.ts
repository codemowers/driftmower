import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkDatabaseSchema } from '../db/schema-check.js'
import { openReadOnlyDatabase, type Database } from '../db/sqlite.js'
import { SqliteWorkloadRepository } from '../db/workload-repository.js'
import { WorkloadSearchService } from './workload-search-service.js'

const FIXTURE_PATH = fileURLToPath(new URL('../../test/fixtures/driftmower-be.sqlite', import.meta.url))

describe('WorkloadSearchService backend database fixture', () => {
  let database: Database
  let service: WorkloadSearchService

  beforeAll(async () => {
    database = await openReadOnlyDatabase(FIXTURE_PATH)
    await checkDatabaseSchema(database)
    service = new WorkloadSearchService(new SqliteWorkloadRepository(database), 20, 100)
  })

  afterAll(async () => {
    await database.destroy()
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
