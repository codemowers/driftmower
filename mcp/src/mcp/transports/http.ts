import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { Readable } from 'node:stream'

export const HTTP_TRANSPORT_NAME = 'http'
export const MCP_PATH = '/mcp'

export interface HttpTransportOptions {
  host: string
  port: number
  onError?: (error: unknown) => void
}

export async function startHttpTransport(
  createMcpServer: () => McpServer,
  options: HttpTransportOptions
): Promise<Server> {
  const sessions = new Map<string, HttpSession>()

  const httpServer = createServer((request, response) => {
    const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname

    if (path !== MCP_PATH) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not_found' }))

      return
    }

    void handleMcpRequest(request, response, createMcpServer, sessions, options).catch((error: unknown) => {
      options.onError?.(error)

      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' })
      }

      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error)
        })
      )
    })
  })

  httpServer.on('close', () => {
    for (const session of sessions.values()) {
      void session.server.close()
    }

    sessions.clear()
  })

  await listen(httpServer, options)

  return httpServer
}

interface HttpSession {
  transport: StreamableHTTPServerTransport
  server: McpServer
}

async function handleMcpRequest(
  request: Parameters<StreamableHTTPServerTransport['handleRequest']>[0],
  response: Parameters<StreamableHTTPServerTransport['handleRequest']>[1],
  createMcpServer: () => McpServer,
  sessions: Map<string, HttpSession>,
  options: HttpTransportOptions
): Promise<void> {
  const sessionId = readSessionId(request.headers['mcp-session-id'])

  if (sessionId) {
    const session = sessions.get(sessionId)

    if (!session) {
      writeJsonError(response, 400, -32000, 'Bad Request: No valid session ID provided')

      return
    }

    await session.transport.handleRequest(request, response)

    return
  }

  if (request.method !== 'POST') {
    writeJsonError(response, 400, -32000, 'Bad Request: No valid session ID provided')

    return
  }

  const parsedBody = await readJsonBody(request)

  if (!containsInitializeRequest(parsedBody)) {
    writeJsonError(response, 400, -32000, 'Bad Request: No valid session ID provided')

    return
  }

  let transport: StreamableHTTPServerTransport
  const server = createMcpServer()

  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized: initializedSessionId => {
      sessions.set(initializedSessionId, { transport, server })
    }
  })
  transport.onerror = error => options.onError?.(error)
  transport.onclose = () => {
    const initializedSessionId = transport.sessionId

    if (initializedSessionId) {
      sessions.delete(initializedSessionId)
    }
  }

  await server.connect(transport)
  await transport.handleRequest(request, response, parsedBody)
}

function readSessionId(value: string | string[] | undefined): string | null {
  if (typeof value === 'string' && value.length > 0) {
    return value
  }

  return null
}

function containsInitializeRequest(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(isInitializeRequest)
  }

  return isInitializeRequest(value)
}

async function readJsonBody(request: Readable): Promise<unknown> {
  const chunks: Buffer[] = []

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeJsonError(
  response: Parameters<StreamableHTTPServerTransport['handleRequest']>[1],
  statusCode: number,
  code: number,
  message: string
): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message },
      id: null
    })
  )
}

function listen(server: Server, options: HttpTransportOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const handleError = (error: Error): void => reject(error)

    server.once('error', handleError)
    server.listen(options.port, options.host, () => {
      server.off('error', handleError)
      resolve()
    })
  })
}
