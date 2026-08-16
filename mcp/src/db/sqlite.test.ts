import BetterSqlite3 from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkDatabaseSchema,
  REQUIRED_COLUMNS,
  REQUIRED_TABLES,
  SchemaCompatibilityError
} from './schema-check.js'
import { openReadOnlyDatabase } from './sqlite.js'

type RequiredTable = keyof typeof REQUIRED_COLUMNS

interface MissingColumn {
  table: RequiredTable
  column: string
}

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
      optionalTables: ['workloads'],
      requiredColumns: {
        reports: REQUIRED_COLUMNS.reports,
        image_usages: REQUIRED_COLUMNS.image_usages,
        release_scores: REQUIRED_COLUMNS.release_scores
      }
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

  it('rejects each missing required column', async () => {
    for (const table of REQUIRED_TABLES) {
      for (const column of REQUIRED_COLUMNS[table]) {
        seedTables(REQUIRED_TABLES, { table, column })
        const database = await openReadOnlyDatabase(databasePath)

        await expect(checkDatabaseSchema(database)).rejects.toMatchObject({
          name: 'SchemaCompatibilityError',
          missingTables: [],
          missingColumns: [`${table}.${column}`]
        } satisfies Partial<SchemaCompatibilityError>)
        await database.destroy()
        await rm(databasePath, { force: true })
      }
    }
  })

  function seedTables(tableNames: readonly string[], missingColumn?: MissingColumn): void {
    const writableDatabase = new BetterSqlite3(databasePath)

    for (const tableName of tableNames) {
      const columns = columnsForTable(tableName, missingColumn)

      writableDatabase.exec(`CREATE TABLE ${tableName} (${columns.join(', ')})`)
    }

    writableDatabase.close()
  }

  function columnsForTable(tableName: string, missingColumn?: MissingColumn): string[] {
    if (!isRequiredTable(tableName)) {
      return ['id TEXT PRIMARY KEY']
    }

    return REQUIRED_COLUMNS[tableName]
      .filter(column => tableName !== missingColumn?.table || column !== missingColumn.column)
      .map(column => `${column} TEXT`)
  }

  function isRequiredTable(tableName: string): tableName is RequiredTable {
    return tableName in REQUIRED_COLUMNS
  }
})
