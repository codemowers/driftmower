import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ApplicationMetrics } from './metrics.js'

export const HEALTH_PATH = '/healthz'
export const READINESS_PATH = '/readyz'
export const STARTUP_PATH = '/startupz'

export interface HealthServerOptions {
  host: string
  port: number
  isReady: () => boolean
  metrics?: ApplicationMetrics
}

export async function startHealthServer(options: HealthServerOptions): Promise<Server> {
  const server = createServer((request, response) => {
    void handleHealthRequest(request, response, options)
  })

  await listen(server, options.host, options.port)

  return server
}

async function handleHealthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: HealthServerOptions
): Promise<void> {
  const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname

  if (request.method !== 'GET') {
    writeJson(response, 405, { error: 'method_not_allowed' })

    return
  }

  if (path === '/metrics' && options.metrics) {
    response.writeHead(200, { 'content-type': options.metrics.registry.contentType })
    response.end(await options.metrics.registry.metrics())

    return
  }

  if (path === HEALTH_PATH) {
    writeJson(response, 200, { status: 'ok' })

    return
  }

  if (path === READINESS_PATH || path === STARTUP_PATH) {
    const ready = options.isReady()

    writeJson(response, ready ? 200 : 503, { status: ready ? 'ok' : 'not_ready' })

    return
  }

  writeJson(response, 404, { error: 'not_found' })
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
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
