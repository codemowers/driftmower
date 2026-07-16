import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'

export const HTTP_TRANSPORT_NAME = 'http'
export const MCP_PATH = '/mcp'

export interface HttpTransportOptions {
  host: string
  port: number
  onError?: (error: unknown) => void
}

export async function startHttpTransport(
  mcpServer: McpServer,
  options: HttpTransportOptions
): Promise<Server> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID
  })

  transport.onerror = error => options.onError?.(error)

  await mcpServer.connect(transport)

  const httpServer = createServer((request, response) => {
    const path = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname

    if (path !== MCP_PATH) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'not_found' }))

      return
    }

    void transport.handleRequest(request, response).catch((error: unknown) => {
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

  await listen(httpServer, options)

  return httpServer
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
