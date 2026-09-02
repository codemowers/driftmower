import BetterSqlite3, { type Database } from 'better-sqlite3'
import type { Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openReadOnlyDatabase } from './sqlite.js'
import { SqliteImageUpdateRepository, type ImageUpdateRepositoryFilters } from './image-update-repository.js'

const REPORT_ID = 'report-1'
let readDatabase: Knex | undefined

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

describe('SqliteImageUpdateRepository', () => {
  let directoryPath: string
  let databasePath: string
  let seedDatabase: Database

  beforeEach(async () => {
    directoryPath = await mkdtemp(join(tmpdir(), 'driftmower-image-updates-'))
    databasePath = join(directoryPath, 'test.sqlite')
    seedDatabase = new BetterSqlite3(databasePath)
    createSchema(seedDatabase)
  })

  afterEach(async () => {
    await readDatabase?.destroy()
    readDatabase = undefined
    seedDatabase.close()
    await rm(directoryPath, { recursive: true, force: true })
  })

  it('deduplicates direct replicas and preserves distinct containers', async () => {
    insertUsage(seedDatabase, { workloadGroupKey: 'deployment:apps:api', versionStatus: 'minor_behind' })
    insertUsage(seedDatabase, { workloadGroupKey: 'deployment:apps:api', versionStatus: 'minor_behind' })
    insertUsage(seedDatabase, {
      workloadGroupKey: 'deployment:apps:api',
      containerName: 'sidecar',
      repository: 'example/sidecar',
      versionStatus: 'patch_behind'
    })
    insertUsage(seedDatabase, {
      workloadGroupKey: 'deployment:apps:ignored',
      latestTag: null,
      versionStatus: 'major_behind'
    })
    insertUsage(seedDatabase, {
      workloadGroupKey: 'deployment:apps:current',
      versionStatus: 'up_to_date'
    })

    const repository = await createRepository(databasePath)
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
    expect(details).toHaveLength(3)
  })

  it('consolidates Helm releases and classifies chart candidates', async () => {
    insertRelease(seedDatabase, 'helm/apps/chart', {
      name: 'chart',
      namespace: 'apps',
      chartName: 'example-chart',
      chartVersion: 'v1.0.0',
      latestChartTag: '1.1.0'
    })
    insertUsage(seedDatabase, {
      workloadGroupKey: 'deployment:apps:chart',
      releaseGroupKey: 'helm/apps/chart',
      versionStatus: 'patch_behind'
    })
    insertUsage(seedDatabase, {
      workloadGroupKey: 'deployment:apps:chart-worker',
      releaseGroupKey: 'helm/apps/chart',
      repository: 'example/worker',
      versionStatus: 'major_behind'
    })
    insertRelease(seedDatabase, 'helm/apps/equal', {
      name: 'equal',
      namespace: 'apps',
      chartVersion: 'v2.0.0',
      latestChartTag: '2.0.0'
    })
    insertUsage(seedDatabase, {
      workloadGroupKey: 'deployment:apps:equal',
      releaseGroupKey: 'helm/apps/equal',
      versionStatus: 'minor_behind'
    })
    insertRelease(seedDatabase, 'helm/other/missing', {
      name: 'missing',
      namespace: 'other',
      chartVersion: '3.0.0'
    })
    insertUsage(seedDatabase, {
      workloadGroupKey: 'deployment:other:missing',
      workloadNamespace: 'other',
      releaseGroupKey: 'helm/other/missing',
      versionStatus: 'behind'
    })

    const repository = await createRepository(databasePath)
    const groups = await repository.listActionGroups({ ...filters(), after: null, limit: 20 })
    const summary = await repository.summarizeActions(filters())
    const appsSummary = await repository.summarizeActions({ ...filters(), namespace: 'apps' })

    expect(groups).toMatchObject([
      {
        actionType: 'helm_chart_update',
        releaseGroupKey: 'helm/apps/chart',
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
    insertUsage(seedDatabase, {
      workloadGroupKey: 'deployment:apps:alpha',
      repository: 'example/alpha',
      versionStatus: 'minor_behind'
    })
    insertUsage(seedDatabase, {
      workloadGroupKey: 'deployment:apps:beta',
      repository: 'example/beta',
      versionStatus: 'minor_behind'
    })
    insertUsage(seedDatabase, {
      workloadGroupKey: 'deployment:apps:gamma',
      repository: 'example/gamma',
      versionStatus: 'patch_behind'
    })

    const repository = await createRepository(databasePath)
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
})

function filters(): ImageUpdateRepositoryFilters {
  return {
    reportId: REPORT_ID,
    namespace: null,
    versionStatuses: ['major_behind', 'minor_behind', 'patch_behind', 'behind']
  }
}

async function createRepository(databasePath: string): Promise<SqliteImageUpdateRepository> {
  readDatabase = await openReadOnlyDatabase(databasePath)

  return new SqliteImageUpdateRepository(readDatabase)
}

function createSchema(database: Database): void {
  database.exec(`
    CREATE TABLE image_usages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id TEXT NOT NULL,
      workload_group_key TEXT NOT NULL,
      workload_kind TEXT,
      workload_namespace TEXT,
      workload_name TEXT,
      release_group_key TEXT,
      container_name TEXT,
      registry TEXT NOT NULL,
      repository TEXT NOT NULL,
      deployed_tag TEXT,
      latest_tag TEXT,
      version_status TEXT
    );
    CREATE TABLE release_scores (
      report_id TEXT NOT NULL,
      group_key TEXT NOT NULL,
      release_info TEXT NOT NULL
    );
  `)
}

function insertUsage(database: Database, input: UsageInput): void {
  database
    .prepare(
      `INSERT INTO image_usages
        (report_id, workload_group_key, workload_kind, workload_namespace, workload_name,
         release_group_key, container_name, registry, repository, deployed_tag, latest_tag,
         version_status)
       VALUES (?, ?, 'Deployment', ?, ?, ?, ?, 'registry.example', ?, ?, ?, ?)`
    )
    .run(
      REPORT_ID,
      input.workloadGroupKey,
      input.workloadNamespace ?? 'apps',
      input.workloadGroupKey.split(':').at(-1),
      input.releaseGroupKey ?? null,
      input.containerName === undefined ? 'main' : input.containerName,
      input.repository ?? 'example/api',
      input.deployedTag === undefined ? '1.0.0' : input.deployedTag,
      input.latestTag === undefined ? '2.0.0' : input.latestTag,
      input.versionStatus ?? null
    )
}

function insertRelease(database: Database, groupKey: string, releaseInfo: object): void {
  database
    .prepare('INSERT INTO release_scores (report_id, group_key, release_info) VALUES (?, ?, ?)')
    .run(REPORT_ID, groupKey, JSON.stringify(releaseInfo))
}
