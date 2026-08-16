import BetterSqlite3, { type Database } from 'better-sqlite3'
import type { Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ALL_NAMESPACE_SCOPE, SqliteReportSnapshotRepository } from './report-snapshot-repository.js'
import { openReadOnlyDatabase } from './sqlite.js'

const SELECTED_NAMESPACE_SCOPE = JSON.stringify({ mode: 'selected', namespaces: ['apps'] })
let readDatabase: Knex | undefined

describe('SqliteReportSnapshotRepository', () => {
  let directoryPath: string
  let databasePath: string
  let seedDatabase: Database

  beforeEach(async () => {
    directoryPath = await mkdtemp(join(tmpdir(), 'driftmower-snapshots-'))
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

  it('selects the latest ready full-cluster report per cluster', async () => {
    insertReport(seedDatabase, 'prod-old', 'prod', '2026-01-01', 'cluster', ALL_NAMESPACE_SCOPE, 'ready')
    insertReport(seedDatabase, 'prod-ready', 'prod', '2026-01-02', 'cluster', ALL_NAMESPACE_SCOPE, 'ready')
    insertReport(
      seedDatabase,
      'prod-in-progress',
      'prod',
      '2026-01-03',
      'cluster',
      ALL_NAMESPACE_SCOPE,
      'in_progress'
    )
    insertReport(seedDatabase, 'stage-ready', 'stage', '2026-01-04', 'cluster', ALL_NAMESPACE_SCOPE, 'ready')
    insertReport(seedDatabase, 'failed', 'stage', '2026-01-05', 'cluster', ALL_NAMESPACE_SCOPE, 'failed')
    insertReport(seedDatabase, 'yaml', 'prod', '2026-01-06', 'yaml', ALL_NAMESPACE_SCOPE, 'ready')
    insertReport(seedDatabase, 'selected', 'prod', '2026-01-07', 'cluster', SELECTED_NAMESPACE_SCOPE, 'ready')
    insertReport(seedDatabase, 'missing-cluster', null, '2026-01-08', 'cluster', ALL_NAMESPACE_SCOPE, 'ready')

    const repository = await createRepository(databasePath)
    const snapshots = await repository.findLatestReadyFullClusterReports()

    expect(snapshots).toMatchObject([
      { reportId: 'prod-ready', clusterContext: 'prod', createdAt: '2026-01-02' },
      { reportId: 'stage-ready', clusterContext: 'stage', createdAt: '2026-01-04' }
    ])
  })

  it('filters by exact cluster context', async () => {
    insertReport(seedDatabase, 'prod', 'prod', '2026-01-01', 'cluster', ALL_NAMESPACE_SCOPE, 'ready')
    insertReport(seedDatabase, 'stage', 'stage', '2026-01-02', 'cluster', ALL_NAMESPACE_SCOPE, 'ready')

    const repository = await createRepository(databasePath)
    const snapshots = await repository.findLatestReadyFullClusterReports('stage')

    expect(snapshots).toMatchObject([{ reportId: 'stage', clusterContext: 'stage', createdAt: '2026-01-02' }])
  })

  it('uses report ID as the deterministic tie breaker', async () => {
    insertReport(seedDatabase, 'report-a', 'prod', '2026-01-01', 'cluster', ALL_NAMESPACE_SCOPE, 'ready')
    insertReport(seedDatabase, 'report-b', 'prod', '2026-01-01', 'cluster', ALL_NAMESPACE_SCOPE, 'ready')

    const repository = await createRepository(databasePath)
    const snapshots = await repository.findLatestReadyFullClusterReports()

    expect(snapshots).toMatchObject([
      { reportId: 'report-b', clusterContext: 'prod', createdAt: '2026-01-01' }
    ])
  })

  it('returns no snapshot when the cluster has no ready report', async () => {
    insertReport(seedDatabase, 'pending', 'prod', '2026-01-01', 'cluster', ALL_NAMESPACE_SCOPE, 'pending')
    insertReport(seedDatabase, 'partial', 'prod', '2026-01-02', 'cluster', ALL_NAMESPACE_SCOPE, 'partial')

    const repository = await createRepository(databasePath)
    const snapshots = await repository.findLatestReadyFullClusterReports('prod')

    expect(snapshots).toEqual([])
  })
})

async function createRepository(databasePath: string): Promise<SqliteReportSnapshotRepository> {
  readDatabase = await openReadOnlyDatabase(databasePath)

  return new SqliteReportSnapshotRepository(readDatabase)
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
  `)
}

function insertReport(
  database: Database,
  id: string,
  cluster: string | null,
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
