import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { REPORTS_PATH } from '../backend/report-snapshot-repository.js'
import type { DriftmowerBackendClient } from '../backend/client.js'

export const HEALTH_PATH = '/healthz'
export const READINESS_PATH = '/readyz'
export const STARTUP_PATH = '/startupz'

export interface HealthServerOptions {
  host: string
  port: number
  client: DriftmowerBackendClient
}

export async function startHealthServer(options: HealthServerOptions): Promise<Server> {
  const server = createServer((request, response) => {
    void handleHealthRequest(request, response, options.client)
  })

  await listen(server, options.host, options.port)

  return server
}

async function handleHealthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  client: DriftmowerBackendClient
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
    const readiness = await checkReadiness(client)

    writeJson(response, readiness.ok ? 200 : 503, readiness.body)

    return
  }

  writeJson(response, 404, { error: 'not_found' })
}

// Readiness is the backend answering an authenticated read. That covers the
// three ways this server is unusable — backend down, credential rejected,
// query surface not the one this version speaks — without reporting anything
// about the data itself.
async function checkReadiness(client: DriftmowerBackendClient): Promise<{
  ok: boolean
  body: Record<string, unknown>
}> {
  try {
    await client.findPage(REPORTS_PATH, { $limit: 1, $select: ['id'] })

    return {
      ok: true,
      body: {
        status: 'ok',
        checks: {
          backend: { ok: true }
        }
      }
    }
  } catch (error) {
    return {
      ok: false,
      body: {
        status: 'not_ready',
        checks: {
          backend: { ok: false, message: errorMessage(error) }
        }
      }
    }
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
