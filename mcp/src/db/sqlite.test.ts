import BetterSqlite3 from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkDatabaseSchema, SchemaCompatibilityError } from './schema-check.js'
import { openReadOnlyDatabase } from './sqlite.js'

const REQUIRED_TABLES = ['reports', 'image_usages', 'release_scores']

describe('read-only SQLite database', () => {
  let directoryPath: string
  let databasePath: string

  beforeEach(async () => {
    directoryPath = await mkdtemp(join(tmpdir(), 'driftmower-mcp-'))
    databasePath = join(directoryPath, 'test.sqlite')
  })

  afterEach(async () => {
    await rm(directoryPath, { recursive: true, force: true })
  })

  it('rejects a missing database file with a clear error', async () => {
    await expect(openReadOnlyDatabase(databasePath)).rejects.toThrow(
      `SQLite database not found at ${databasePath}`
    )
  })

  it('opens an existing database read-only and rejects writes', async () => {
    const writableDatabase = new BetterSqlite3(databasePath)

    writableDatabase.exec('CREATE TABLE reports (id TEXT PRIMARY KEY)')
    writableDatabase.close()
    const database = await openReadOnlyDatabase(databasePath)

    await expect(database('reports').insert({ id: 'report-1' })).rejects.toThrow('readonly database')
    await database.destroy()
  })

  it('accepts a compatible schema and reports optional tables', async () => {
    seedTables([...REQUIRED_TABLES, 'workloads'])
    const database = await openReadOnlyDatabase(databasePath)

    await expect(checkDatabaseSchema(database)).resolves.toMatchObject({
      requiredTables: REQUIRED_TABLES,
      optionalTables: ['workloads']
    })
    await database.destroy()
  })

  it('rejects each missing required table', async () => {
    for (const missingTable of REQUIRED_TABLES) {
      seedTables(REQUIRED_TABLES.filter(table => table !== missingTable))
      const database = await openReadOnlyDatabase(databasePath)

      await expect(checkDatabaseSchema(database)).rejects.toMatchObject({
        name: 'SchemaCompatibilityError',
        missingTables: [missingTable]
      } satisfies Partial<SchemaCompatibilityError>)
      await database.destroy()
      await rm(databasePath, { force: true })
    }
  })

  function seedTables(tableNames: string[]): void {
    const writableDatabase = new BetterSqlite3(databasePath)

    for (const tableName of tableNames) {
      writableDatabase.exec(`CREATE TABLE ${tableName} (id TEXT PRIMARY KEY)`)
    }

    writableDatabase.close()
  }
})
