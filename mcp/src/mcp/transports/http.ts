import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Readable } from 'node:stream'
import {
  protectedResourceMetadataPath,
  type BearerAuthenticator,
  type RejectedCall
} from '../../auth/bearer.js'

export const HTTP_TRANSPORT_NAME = 'http'
export const MCP_PATH = '/mcp'
export const PROTECTED_RESOURCE_METADATA_PATH = protectedResourceMetadataPath(MCP_PATH)
// Clients differ on whether they append the resource path to the well-known
// prefix, so both spellings are served.
export const PROTECTED_RESOURCE_METADATA_ROOT_PATH = '/.well-known/oauth-protected-resource'

export interface HttpTransportOptions {
  host: string
  port: number
  // Absent means the transport serves unauthenticated, which is only correct
  // for a server that is not reachable from outside the cluster.
  authenticator?: BearerAuthenticator
  onError?: (error: unknown) => void
  onAudit?: (entry: AuditEntry) => void
}

export interface AuditEntry {
  event: 'rejected' | 'accepted'
  subject: string | null
  reason?: string
}

export async function startHttpTransport(
  createMcpServer: () => McpServer,
  options: HttpTransportOptions
): Promise<Server> {
  const sessions = new Map<string, HttpSession>()

  const httpServer = createServer((request, response) => {
    const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname

    if (
      options.authenticator &&
      request.method === 'GET' &&
      (path === PROTECTED_RESOURCE_METADATA_PATH || path === PROTECTED_RESOURCE_METADATA_ROOT_PATH)
    ) {
      // Unauthenticated by design: RFC 9728 metadata is what an unauthenticated
      // client reads to find out how to authenticate.
      writeJson(response, 200, options.authenticator.protectedResourceMetadata())

      return
    }

    if (path !== MCP_PATH) {
      writeJson(response, 404, { error: 'not_found' })

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
  // The `sub` that initialized this session, or null when the transport runs
  // unauthenticated. A session id is a bearer credential in its own right:
  // without this binding, anyone who learned one would inherit the tenancy of
  // the caller who created it.
  subject: string | null
}

async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  createMcpServer: () => McpServer,
  sessions: Map<string, HttpSession>,
  options: HttpTransportOptions
): Promise<void> {
  let authInfo: AuthInfo | undefined
  let subject: string | null = null

  if (options.authenticator) {
    const outcome = await options.authenticator.authenticate(request.headers)

    if (!outcome.ok) {
      options.onAudit?.({ event: 'rejected', subject: null, reason: outcome.description })
      writeChallenge(response, options.authenticator, outcome)

      return
    }

    authInfo = outcome.authInfo
    subject = outcome.caller.sub
  }

  const sessionId = readSessionId(request.headers['mcp-session-id'])

  if (sessionId) {
    const session = sessions.get(sessionId)

    if (!session) {
      writeJsonError(response, 400, -32000, 'Bad Request: No valid session ID provided')

      return
    }

    if (session.subject !== subject) {
      options.onAudit?.({ event: 'rejected', subject, reason: 'session belongs to another subject' })
      writeJsonError(response, 403, -32003, 'Forbidden: session belongs to another subject')

      return
    }

    await session.transport.handleRequest(withAuth(request, authInfo), response)

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

  const server = createMcpServer()
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized: initializedSessionId => {
      sessions.set(initializedSessionId, { transport, server, subject })
    }
  })

  transport.onerror = error => options.onError?.(error)
  transport.onclose = () => {
    const initializedSessionId = transport.sessionId

    if (initializedSessionId) {
      sessions.delete(initializedSessionId)
    }
  }

  options.onAudit?.({ event: 'accepted', subject })

  await server.connect(transport)
  await transport.handleRequest(withAuth(request, authInfo), response, parsedBody)
}

// The SDK reads `req.auth` and hands it to tool handlers as `extra.authInfo`.
// That channel is the only safe way to carry per-caller identity: the MCP
// server and the services behind it are shared across concurrent requests.
function withAuth(request: IncomingMessage, authInfo: AuthInfo | undefined): IncomingMessage {
  return Object.assign(request, { auth: authInfo })
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

function writeChallenge(
  response: ServerResponse,
  authenticator: BearerAuthenticator,
  outcome: RejectedCall
): void {
  response.writeHead(outcome.status, {
    'content-type': 'application/json',
    'www-authenticate': authenticator.challengeHeader(outcome)
  })
  response.end(JSON.stringify({ error: outcome.error, error_description: outcome.description }))
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function writeJsonError(response: ServerResponse, statusCode: number, code: number, message: string): void {
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
