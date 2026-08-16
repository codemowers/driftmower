import type { Knex } from 'knex'

export const REQUIRED_TABLES = ['reports', 'image_usages', 'release_scores'] as const
export const OPTIONAL_TABLES = ['workloads', 'workload_scores'] as const
export const REQUIRED_COLUMNS = {
  reports: ['id', 'source_type', 'cluster_context', 'created_at', 'namespace_scope', 'status'],
  image_usages: [
    'report_id',
    'workload_group_key',
    'workload_kind',
    'workload_namespace',
    'workload_name',
    'release_group_key',
    'container_name',
    'registry',
    'repository',
    'deployed_tag',
    'latest_tag',
    'status',
    'version_status'
  ],
  release_scores: ['report_id', 'group_key', 'release_info']
} as const

type RequiredTable = (typeof REQUIRED_TABLES)[number]

export type RequiredColumnResult = Record<RequiredTable, string[]>

interface TableNameRow {
  name: string
}

export interface SchemaCheckResult {
  requiredTables: string[]
  optionalTables: string[]
  requiredColumns: RequiredColumnResult
}

export class SchemaCompatibilityError extends Error {
  constructor(
    public readonly missingTables: string[],
    public readonly missingColumns: string[] = []
  ) {
    super(schemaCompatibilityMessage(missingTables, missingColumns))
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

  const missingColumns = await findMissingColumns(database)

  if (missingColumns.length > 0) {
    throw new SchemaCompatibilityError([], missingColumns)
  }

  return {
    requiredTables: REQUIRED_TABLES.filter(table => foundTables.has(table)),
    optionalTables: OPTIONAL_TABLES.filter(table => foundTables.has(table)),
    requiredColumns: copyRequiredColumns()
  }
}

async function findMissingColumns(database: Knex): Promise<string[]> {
  const missingColumns: string[] = []

  for (const table of REQUIRED_TABLES) {
    const columnInfo = await database(table).columnInfo()
    const foundColumns = new Set(Object.keys(columnInfo))

    for (const column of REQUIRED_COLUMNS[table]) {
      if (!foundColumns.has(column)) {
        missingColumns.push(`${table}.${column}`)
      }
    }
  }

  return missingColumns
}

function copyRequiredColumns(): RequiredColumnResult {
  return {
    reports: [...REQUIRED_COLUMNS.reports],
    image_usages: [...REQUIRED_COLUMNS.image_usages],
    release_scores: [...REQUIRED_COLUMNS.release_scores]
  }
}

function schemaCompatibilityMessage(missingTables: string[], missingColumns: string[]): string {
  const problems: string[] = []

  if (missingTables.length > 0) {
    problems.push(`missing required tables: ${missingTables.join(', ')}`)
  }

  if (missingColumns.length > 0) {
    problems.push(`missing required columns: ${missingColumns.join(', ')}`)
  }

  return `Incompatible Driftmower database: ${problems.join('; ')}`
}
