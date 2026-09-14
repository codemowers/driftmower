import { beforeAll, describe, expect, it } from 'vitest'
import { BackendImageUpdateRepository } from '../backend/image-update-repository.js'
import { BackendReportSnapshotRepository } from '../backend/report-snapshot-repository.js'
import { ReportRowLoader } from '../backend/report-rows.js'
import { createFakeBackend } from '../../test/fake-backend.js'
import { ImageUpdatePlanningService } from './image-update-planning-service.js'

const FIXTURE_REPORT_ID = '0b249694-625d-41c8-a788-5b207c9c4d6b'

// Drives the service against rows recorded from a real full-cluster analysis,
// served over the same HTTP path production uses.
describe('ImageUpdatePlanningService against recorded backend rows', () => {
  let service: ImageUpdatePlanningService

  beforeAll(() => {
    const { client } = createFakeBackend()
    const rowLoader = new ReportRowLoader(client)

    service = new ImageUpdatePlanningService(
      new BackendImageUpdateRepository(rowLoader),
      new BackendReportSnapshotRepository(client),
      20,
      100
    )
  })

  it('maps real image analysis into direct, Helm, and manual actions', async () => {
    const result = await service.planImageUpdates({ limit: 100 })

    expect(result.status).toBe('ok')

    if (result.status !== 'ok') {
      throw new Error('Expected the fixture to have a ready report')
    }

    const directAction = result.actions.find(action => action.type === 'image_tag_update')
    const helmAction = result.actions.find(
      action => action.type === 'helm_chart_update' && action.releaseName === 'cert-manager'
    )
    const manualAction = result.actions.find(action => action.type === 'manual_review')

    expect(result).toMatchObject({
      snapshot: {
        reportId: FIXTURE_REPORT_ID,
        createdAt: '2026-07-13 20:14:51'
      },
      filters: {
        namespace: null,
        versionStatuses: ['major_behind', 'minor_behind', 'patch_behind', 'behind']
      },
      nextCursor: null
    })
    expect(result.summary.imageTagUpdates).toBeGreaterThan(0)
    expect(result.summary.helmChartUpdates).toBeGreaterThan(0)
    expect(result.summary.manualReviews).toBeGreaterThan(0)
    expect(result.summary.totalActions).toBe(result.actions.length)
    expect(directAction).toMatchObject({
      type: 'image_tag_update',
      currentImage: { tag: expect.any(String) },
      proposedImage: { tag: expect.any(String) }
    })
    expect(helmAction).toMatchObject({
      type: 'helm_chart_update',
      releaseNamespace: 'cert-manager',
      chartName: 'cert-manager',
      observedChartVersion: 'v1.20.0',
      latestKnownChartVersion: '1.21.0'
    })

    if (helmAction?.type !== 'helm_chart_update') {
      throw new Error('Expected a cert-manager Helm chart update action')
    }

    expect(helmAction.imageEvidence[0]).toMatchObject({
      proposedImage: {
        repository: 'jetstack/cert-manager-controller',
        tag: 'v1.21.0'
      }
    })
    expect(manualAction).toMatchObject({
      type: 'manual_review',
      reason: expect.stringMatching(/^(missing_chart_candidate|chart_candidate_not_distinct)$/)
    })
    expect(JSON.stringify(result)).not.toContain('chartTags')
    expect(JSON.stringify(result)).not.toContain('release_info')
  })

  it('continues from the same pinned snapshot without repeating actions', async () => {
    const firstPage = await service.planImageUpdates({ limit: 2 })

    expect(firstPage.status).toBe('ok')

    if (firstPage.status !== 'ok' || firstPage.nextCursor === null) {
      throw new Error('Expected the fixture to produce a continuation cursor')
    }

    const secondPage = await service.planImageUpdates({
      limit: 2,
      cursor: firstPage.nextCursor
    })

    expect(secondPage.status).toBe('ok')

    if (secondPage.status !== 'ok') {
      throw new Error('Expected the continuation page to use a ready report')
    }

    const firstPageActionIds = new Set(firstPage.actions.map(action => action.actionId))
    const repeatedActionIds = secondPage.actions.filter(action => firstPageActionIds.has(action.actionId))

    expect(secondPage.snapshot).toMatchObject({ reportId: FIXTURE_REPORT_ID })
    expect(repeatedActionIds).toHaveLength(0)
  })
})
