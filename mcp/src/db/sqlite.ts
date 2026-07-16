import { access } from 'node:fs/promises'
import knex, { type Knex } from 'knex'

export type Database = Knex

export async function openReadOnlyDatabase(databasePath: string): Promise<Knex> {
  try {
    await access(databasePath)
  } catch {
    throw new Error(`SQLite database not found at ${databasePath}`)
  }

  const database = knex({
    client: 'better-sqlite3',
    connection: {
      filename: databasePath,
      options: {
        readonly: true
      }
    },
    useNullAsDefault: true
  })

  try {
    await database.raw('PRAGMA query_only = ON')

    return database
  } catch (error) {
    await database.destroy()
    throw error
  }
}
