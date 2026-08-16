import BetterSqlite3 from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REQUIRED_COLUMNS } from '../db/schema-check.js'
import { startHealthServer } from './health.js'

describe('health server', () => {
  let directoryPath: string
  let databasePath: string
  let server: Server | undefined

  beforeEach(async () => {
    directoryPath = await mkdtemp(join(tmpdir(), 'driftmower-health-'))
    databasePath = join(directoryPath, 'test.sqlite')
  })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close(error => (error ? reject(error) : resolve()))
      })
      server = undefined
    }

    await rm(directoryPath, { recursive: true, force: true })
  })

  it('reports liveness even when the database is missing', async () => {
    const baseUrl = await startServer()

    const response = await fetch(`${baseUrl}/healthz`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })
  })

  it('reports not ready when the database is missing or incompatible', async () => {
    const baseUrl = await startServer()
    const missingResponse = await fetch(`${baseUrl}/readyz`)
    const incompatibleDatabase = new BetterSqlite3(databasePath)

    incompatibleDatabase.exec('CREATE TABLE reports (id TEXT PRIMARY KEY)')
    incompatibleDatabase.close()

    const incompatibleResponse = await fetch(`${baseUrl}/startupz`)

    expect(missingResponse.status).toBe(503)
    expect(incompatibleResponse.status).toBe(503)
    await expect(incompatibleResponse.json()).resolves.toMatchObject({
      status: 'not_ready',
      checks: { database: { ok: true }, schema: { ok: false } }
    })
  })

  it('reports ready for a compatible read-only database', async () => {
    const database = new BetterSqlite3(databasePath)

    for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
      const columns = requiredColumns.map(column => `${column} TEXT`)

      database.exec(`CREATE TABLE ${table} (${columns.join(', ')})`)
    }

    database.close()
    const baseUrl = await startServer()

    const response = await fetch(`${baseUrl}/readyz`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      checks: { database: { ok: true }, schema: { ok: true } }
    })
  })

  async function startServer(): Promise<string> {
    server = await startHealthServer({ host: '127.0.0.1', port: 0, databasePath })
    const address = server.address() as AddressInfo

    return `http://127.0.0.1:${address.port}`
  }
})
