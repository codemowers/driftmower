import { describe, expect, it } from 'vitest'
import { createFakeBackend } from '../../test/fake-backend.js'
import { ReportRowLoader } from './report-rows.js'

function usage(reportId: string) {
  return {
    reportId,
    workloadGroupKey: 'deployment:apps:api',
    workloadKind: 'Deployment',
    workloadNamespace: 'apps',
    workloadName: 'api',
    releaseGroupKey: null,
    containerName: 'main',
    registry: 'registry.example',
    repository: 'example/api',
    deployedTag: '1.0.0',
    latestTag: '2.0.0',
    status: 'outdated',
    versionStatus: 'behind'
  }
}

function usageRequests(requests: string[]): string[] {
  return requests.filter(request => request.startsWith('/image-usages'))
}

describe('ReportRowLoader', () => {
  it('shares one fetch between concurrent loads of the same report', async () => {
    const { client, requests } = createFakeBackend({
      rows: { 'image-usages': [usage('report-1')], 'release-scores': [] }
    })
    const loader = new ReportRowLoader(client)

    const [first, second] = await Promise.all([loader.load('report-1'), loader.load('report-1')])

    expect(first).toBe(second)
    expect(usageRequests(requests)).toHaveLength(1)
  })

  it('keeps a working set larger than a handful of clusters resident', async () => {
    const reportIds = Array.from({ length: 6 }, (_, index) => `report-${index}`)
    const { client, requests } = createFakeBackend({
      rows: { 'image-usages': reportIds.map(usage), 'release-scores': [] }
    })
    const loader = new ReportRowLoader(client)

    // Two searches across six clusters: the second must be served from cache.
    for (const reportId of reportIds) {
      await loader.load(reportId)
    }

    for (const reportId of reportIds) {
      await loader.load(reportId)
    }

    expect(usageRequests(requests)).toHaveLength(reportIds.length)
  })

  it('evicts the least recently used report once the bound is exceeded', async () => {
    const reportIds = Array.from({ length: 17 }, (_, index) => `report-${String(index).padStart(2, '0')}`)
    const { client, requests } = createFakeBackend({
      rows: { 'image-usages': reportIds.map(usage), 'release-scores': [] }
    })
    const loader = new ReportRowLoader(client)

    for (const reportId of reportIds.slice(0, 16)) {
      await loader.load(reportId)
    }

    // Touch the oldest so it is no longer the eviction candidate.
    await loader.load('report-00')
    await loader.load('report-16')

    const before = usageRequests(requests).length

    await loader.load('report-00')
    expect(usageRequests(requests)).toHaveLength(before)

    await loader.load('report-01')
    expect(usageRequests(requests)).toHaveLength(before + 1)
  })

  it('does not cache a failed load', async () => {
    let failures = 1
    const { client } = createFakeBackend({
      rows: { 'image-usages': [usage('report-1')], 'release-scores': [] }
    })
    const failing = new ReportRowLoader(
      Object.assign(Object.create(Object.getPrototypeOf(client)), client, {
        findAll: async (...args: Parameters<typeof client.findAll>) => {
          if (failures > 0) {
            failures -= 1

            throw new Error('backend unavailable')
          }

          return client.findAll(...args)
        }
      })
    )

    await expect(failing.load('report-1')).rejects.toThrow('backend unavailable')
    await expect(failing.load('report-1')).resolves.toMatchObject({ imageUsages: [expect.any(Object)] })
  })
})
