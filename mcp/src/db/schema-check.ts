import type { Knex } from 'knex'

export const REQUIRED_TABLES = ['reports', 'image_usages', 'release_scores'] as const
export const OPTIONAL_TABLES = ['workloads', 'workload_scores'] as const

interface TableNameRow {
  name: string
}

export interface SchemaCheckResult {
  requiredTables: string[]
  optionalTables: string[]
}

export class SchemaCompatibilityError extends Error {
  constructor(public readonly missingTables: string[]) {
    super(`Incompatible Driftmower database: missing required tables: ${missingTables.join(', ')}`)
    this.name = 'SchemaCompatibilityError'
  }
}

export async function checkDatabaseSchema(database: Knex): Promise<SchemaCheckResult> {
  const expectedTables = [...REQUIRED_TABLES, ...OPTIONAL_TABLES]
  // Read SQLite's schema catalog once to validate required tables and discover optional ones.
  const rows = await database<TableNameRow>('sqlite_master')
    .select('name')
    .where('type', 'table')
    .whereIn('name', expectedTables)
  const foundTables = new Set(rows.map(row => row.name))
  const missingTables = REQUIRED_TABLES.filter(table => !foundTables.has(table))

  if (missingTables.length > 0) {
    throw new SchemaCompatibilityError([...missingTables])
  }

  return {
    requiredTables: REQUIRED_TABLES.filter(table => foundTables.has(table)),
    optionalTables: OPTIONAL_TABLES.filter(table => foundTables.has(table))
  }
}
