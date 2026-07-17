import BetterSqlite3, { type Database } from 'better-sqlite3'
import type { Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openReadOnlyDatabase } from './sqlite.js'
import { SqliteWorkloadRepository } from './workload-repository.js'

const ALL_NAMESPACES = JSON.stringify({ mode: 'all' })
const SELECTED_NAMESPACES = JSON.stringify({ mode: 'selected', namespaces: ['apps'] })
let readDatabase: Knex | undefined

describe('SqliteWorkloadRepository', () => {
  let directoryPath: string
  let databasePath: string
  let seedDatabase: Database

  beforeEach(async () => {
    directoryPath = await mkdtemp(join(tmpdir(), 'driftmower-repository-'))
    databasePath = join(directoryPath, 'test.sqlite')
    seedDatabase = new BetterSqlite3(databasePath)
    createSchema(seedDatabase)
  })

  afterEach(async () => {
    await readDatabase?.destroy()
    seedDatabase.close()
    await rm(directoryPath, { recursive: true, force: true })
  })

  it('searches only the latest full-cluster report per cluster and ignores status', async () => {
    insertReport(seedDatabase, 'old-full', 'prod', '2026-01-01', 'cluster', ALL_NAMESPACES, 'ready')
    insertReport(seedDatabase, 'latest-full', 'prod', '2026-01-02', 'cluster', ALL_NAMESPACES, 'pending')
    insertReport(
      seedDatabase,
      'newer-selected',
      'prod',
      '2026-01-03',
      'cluster',
      SELECTED_NAMESPACES,
      'ready'
    )
    insertReport(seedDatabase, 'newest-yaml', 'prod', '2026-01-04', 'yaml', ALL_NAMESPACES, 'ready')
    insertReport(seedDatabase, 'stage-full', 'stage', '2026-01-02', 'cluster', ALL_NAMESPACES, 'pending')
    insertUsage(seedDatabase, 'old-full', 'old', 'memelord-old')
    insertUsage(seedDatabase, 'latest-full', 'prod', 'Memelord')
    insertUsage(seedDatabase, 'newer-selected', 'selected', 'memelord-selected')
    insertUsage(seedDatabase, 'newest-yaml', 'yaml', 'memelord-yaml')
    insertUsage(seedDatabase, 'stage-full', 'stage', 'memelord-stage')

    const repository = await createRepository(databasePath)
    const groups = await repository.searchMatchingGroups('MEMELORD', 20)

    expect(groups).toHaveLength(2)
    expect(groups.map(group => group.reportId)).toEqual(['latest-full', 'stage-full'])
    expect(groups[0]).toMatchObject({
      clusterContext: 'prod',
      reportCreatedAt: '2026-01-02',
      workloadName: 'Memelord',
      matchRank: 0
    })
  })

  it('ranks exact, prefix, and substring matches deterministically', async () => {
    insertReport(seedDatabase, 'report', 'prod', '2026-01-01', 'cluster', ALL_NAMESPACES, 'pending')
    insertUsage(seedDatabase, 'report', 'substring', 'our-api-worker')
    insertUsage(seedDatabase, 'report', 'prefix', 'api-worker')
    insertUsage(seedDatabase, 'report', 'exact', 'API')

    const repository = await createRepository(databasePath)
    const groups = await repository.searchMatchingGroups('api', 20)

    expect(groups.map(group => [group.workloadName, group.matchRank])).toEqual([
      ['API', 0],
      ['api-worker', 1],
      ['our-api-worker', 2]
    ])
  })

  it('limits workload groups rather than image rows', async () => {
    insertReport(seedDatabase, 'report', 'prod', '2026-01-01', 'cluster', ALL_NAMESPACES, 'pending')
    insertUsage(seedDatabase, 'report', 'alpha', 'api-alpha', 'api/alpha', 'main')
    insertUsage(seedDatabase, 'report', 'alpha', 'api-alpha', 'api/sidecar', 'sidecar')
    insertUsage(seedDatabase, 'report', 'beta', 'api-beta', 'api/beta', 'main')

    const repository = await createRepository(databasePath)
    const groups = await repository.searchMatchingGroups('api', 1)
    const details = await repository.loadWorkloadDetails(groups)

    expect(groups).toHaveLength(1)
    expect(details).toHaveLength(2)
    expect(details.map(detail => detail.repository)).toEqual(['api/alpha', 'api/sidecar'])
  })

  it('joins release analysis while retaining non-Helm image rows', async () => {
    insertReport(seedDatabase, 'report', 'prod', '2026-01-01', 'cluster', ALL_NAMESPACES, 'pending')
    insertUsage(seedDatabase, 'report', 'helm', 'helm-api', 'api/helm', 'main', 'release-1')
    insertUsage(seedDatabase, 'report', 'plain', 'plain-api', 'api/plain', 'main')
    seedDatabase
      .prepare('INSERT INTO release_scores (report_id, group_key, release_info) VALUES (?, ?, ?)')
      .run('report', 'release-1', JSON.stringify({ chartName: 'api' }))

    const repository = await createRepository(databasePath)
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
})

async function createRepository(databasePath: string): Promise<SqliteWorkloadRepository> {
  readDatabase = await openReadOnlyDatabase(databasePath)

  return new SqliteWorkloadRepository(readDatabase)
}

function createSchema(database: Database): void {
  database.exec(`
    CREATE TABLE reports (
      id TEXT PRIMARY KEY,
      cluster_context TEXT,
      created_at TEXT NOT NULL,
      source_type TEXT NOT NULL,
      namespace_scope TEXT,
      status TEXT NOT NULL
    );
    CREATE TABLE image_usages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id TEXT NOT NULL,
      workload_group_key TEXT NOT NULL,
      workload_kind TEXT,
      workload_namespace TEXT,
      workload_name TEXT,
      release_group_key TEXT,
      registry TEXT NOT NULL,
      repository TEXT NOT NULL,
      deployed_tag TEXT,
      latest_tag TEXT,
      status TEXT NOT NULL,
      version_status TEXT,
      container_name TEXT
    );
    CREATE TABLE release_scores (
      report_id TEXT NOT NULL,
      group_key TEXT NOT NULL,
      release_info TEXT NOT NULL
    );
  `)
}

function insertReport(
  database: Database,
  id: string,
  cluster: string,
  createdAt: string,
  sourceType: string,
  namespaceScope: string,
  status: string
): void {
  database
    .prepare(
      `INSERT INTO reports
        (id, cluster_context, created_at, source_type, namespace_scope, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, cluster, createdAt, sourceType, namespaceScope, status)
}

function insertUsage(
  database: Database,
  reportId: string,
  groupKey: string,
  workloadName: string,
  repository = 'example/workload',
  containerName = 'main',
  releaseGroupKey: string | null = null
): void {
  database
    .prepare(
      `INSERT INTO image_usages
        (report_id, workload_group_key, workload_kind, workload_namespace, workload_name,
         release_group_key, registry, repository, deployed_tag, latest_tag, status,
         version_status, container_name)
       VALUES (?, ?, 'Deployment', 'apps', ?, ?, 'registry.example', ?, '1.0.0', '2.0.0',
               'analyzed', 'outdated', ?)`
    )
    .run(reportId, groupKey, workloadName, releaseGroupKey, repository, containerName)
}
