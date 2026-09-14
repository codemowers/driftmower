import { beforeAll, describe, expect, it } from 'vitest'
import { BackendImageUpdateRepository } from '../backend/image-update-repository.js'
import { BackendReportSnapshotRepository } from '../backend/report-snapshot-repository.js'
import { ReportRowLoader } from '../backend/report-rows.js'
import { BackendWorkloadRepository } from '../backend/workload-repository.js'
import { UNRESTRICTED_SCOPE, type ResolvedScope } from '../domain/tenancy.js'
import { createFakeBackend } from '../../test/fake-backend.js'
import { ImageUpdatePlanningService } from './image-update-planning-service.js'
import { WorkloadSearchService } from './workload-search-service.js'

// Tenancy scoping proven against rows recorded from a real cluster analysis
// rather than a stub: the point of these tests is that the scope actually
// confines results, including for the Helm actions whose groups carry no
// namespace of their own.

const claimScope = (namespaces: string[]): ResolvedScope => ({ scope: namespaces, source: 'claim' })
const missingClaimScope: ResolvedScope = { scope: [], source: 'claim-missing' }

describe('tenancy scoping against recorded backend rows', () => {
  let searchService: WorkloadSearchService
  let planningService: ImageUpdatePlanningService

  beforeAll(() => {
    const { client } = createFakeBackend()
    const rowLoader = new ReportRowLoader(client)
    const reportSnapshotRepository = new BackendReportSnapshotRepository(client)

    searchService = new WorkloadSearchService(
      new BackendWorkloadRepository(rowLoader, reportSnapshotRepository),
      20,
      100
    )
    planningService = new ImageUpdatePlanningService(
      new BackendImageUpdateRepository(rowLoader),
      reportSnapshotRepository,
      20,
      100
    )
  })

  describe('search_workloads', () => {
    it('returns cert-manager unscoped', async () => {
      const result = await searchService.searchWorkloads({
        query: 'cert-manager',
        scope: UNRESTRICTED_SCOPE
      })

      expect(result.matches.length).toBeGreaterThan(0)
      expect(result.scope).toEqual({ scoped: false, namespaces: null, note: null })
    })

    it('withholds a workload outside the caller namespaces, and says so', async () => {
      const result = await searchService.searchWorkloads({
        query: 'cert-manager',
        scope: claimScope(['memelord-laurivosandi'])
      })

      expect(result.matches).toHaveLength(0)
      expect(result.scope.scoped).toBe(true)
      // The distinction that matters: an agent must not report this as "no such
      // workload exists".
      expect(result.scope.note).toContain('outside your access')
    })

    it('returns a workload inside the caller namespaces', async () => {
      const result = await searchService.searchWorkloads({
        query: 'cert-manager',
        scope: claimScope(['cert-manager'])
      })

      expect(result.matches.length).toBeGreaterThan(0)
      expect(result.matches.every(match => match.namespace === 'cert-manager')).toBe(true)
    })

    it('returns nothing when the token carries no tenancy claim', async () => {
      const result = await searchService.searchWorkloads({
        query: 'cert-manager',
        scope: missingClaimScope
      })

      expect(result.matches).toHaveLength(0)
      expect(result.scope.note).toContain('no namespaces claim')
    })
  })

  describe('plan_image_updates', () => {
    it('plans actions across the cluster when unscoped', async () => {
      const result = await planningService.planImageUpdates({ scope: UNRESTRICTED_SCOPE })

      expect(result.status).toBe('ok')
      expect(result.summary.totalActions).toBeGreaterThan(0)
      expect(result.scope.scoped).toBe(false)
    })

    it('confines actions to the caller namespaces', async () => {
      const scoped = await planningService.planImageUpdates({ scope: claimScope(['cert-manager']) })
      const unscoped = await planningService.planImageUpdates({ scope: UNRESTRICTED_SCOPE })

      expect(scoped.summary.totalActions).toBeLessThan(unscoped.summary.totalActions)
      expect(scoped.scope.namespaces).toEqual(['cert-manager'])
    })

    it('drops a Helm release whose workloads all fall outside the scope', async () => {
      // Helm groups carry no namespace of their own; they are derived from the
      // image_usages rows, so scoping those has to make the release disappear.
      const unscoped = await planningService.planImageUpdates({
        scope: UNRESTRICTED_SCOPE,
        limit: 100
      })
      const helmReleasesUnscoped = unscoped.actions.filter(action => action.type !== 'image_tag_update')

      expect(helmReleasesUnscoped.length).toBeGreaterThan(0)

      const scoped = await planningService.planImageUpdates({
        scope: claimScope(['memelord-laurivosandi']),
        limit: 100
      })
      const certManagerRelease = scoped.actions.find(
        action => action.type !== 'image_tag_update' && action.releaseNamespace === 'cert-manager'
      )

      expect(certManagerRelease).toBeUndefined()
    })

    it('returns an empty plan with an explanation when the claim is absent', async () => {
      const result = await planningService.planImageUpdates({ scope: missingClaimScope })

      expect(result.summary.totalActions).toBe(0)
      expect(result.actions).toHaveLength(0)
      expect(result.scope.note).toContain('no namespaces claim')
    })
  })
})
