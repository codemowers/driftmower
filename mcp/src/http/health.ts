import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { checkDatabaseSchema } from '../db/schema-check.js'
import { openReadOnlyDatabase } from '../db/sqlite.js'

export const HEALTH_PATH = '/healthz'
export const READINESS_PATH = '/readyz'
export const STARTUP_PATH = '/startupz'

export interface HealthServerOptions {
  host: string
  port: number
  databasePath: string
}

export async function startHealthServer(options: HealthServerOptions): Promise<Server> {
  const server = createServer((request, response) => {
    void handleHealthRequest(request, response, options.databasePath)
  })

  await listen(server, options.host, options.port)

  return server
}

async function handleHealthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string
): Promise<void> {
  const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname

  if (request.method !== 'GET') {
    writeJson(response, 405, { error: 'method_not_allowed' })

    return
  }

  if (path === HEALTH_PATH) {
    writeJson(response, 200, { status: 'ok' })

    return
  }

  if (path === READINESS_PATH || path === STARTUP_PATH) {
    const readiness = await checkReadiness(databasePath)

    writeJson(response, readiness.ok ? 200 : 503, readiness.body)

    return
  }

  writeJson(response, 404, { error: 'not_found' })
}

async function checkReadiness(databasePath: string): Promise<{
  ok: boolean
  body: Record<string, unknown>
}> {
  let database

  try {
    database = await openReadOnlyDatabase(databasePath)
  } catch (error) {
    return {
      ok: false,
      body: {
        status: 'not_ready',
        checks: {
          database: { ok: false, message: errorMessage(error) }
        }
      }
    }
  }

  try {
    await checkDatabaseSchema(database)

    return {
      ok: true,
      body: {
        status: 'ok',
        checks: {
          database: { ok: true },
          schema: { ok: true }
        }
      }
    }
  } catch (error) {
    return {
      ok: false,
      body: {
        status: 'not_ready',
        checks: {
          database: { ok: true },
          schema: { ok: false, message: errorMessage(error) }
        }
      }
    }
  } finally {
    await database.destroy()
  }
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error): void => reject(error)

    server.once('error', handleError)
    server.listen(port, host, () => {
      server.off('error', handleError)
      resolve()
    })
  })
}
