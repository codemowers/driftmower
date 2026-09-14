import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthOutcome, BearerAuthenticator, RejectedCall } from '../../auth/bearer.js'
import { createMcpServer } from '../create-server.js'
import {
  PROTECTED_RESOURCE_METADATA_PATH,
  PROTECTED_RESOURCE_METADATA_ROOT_PATH,
  startHttpTransport
} from './http.js'

const METADATA = {
  resource: 'https://driftmower-mcp.example/mcp',
  authorization_servers: ['https://passmower.example/'],
  bearer_methods_supported: ['header']
}

// A stand-in for the real authenticator: the token verification itself is
// covered in src/auth/verify-access-token.test.ts, so these tests are about
// what the transport does with a verdict.
function authenticatorFor(outcomes: Map<string, AuthOutcome>): BearerAuthenticator {
  return {
    authenticate: async headers => {
      const header = headers.authorization
      const token = typeof header === 'string' ? header.replace(/^Bearer /i, '') : ''

      return (
        outcomes.get(token) ?? {
          ok: false,
          status: 401,
          error: 'invalid_token',
          description: 'no such token'
        }
      )
    },
    challengeHeader: (outcome: RejectedCall) =>
      `Bearer error="${outcome.error}", resource_metadata="${METADATA.resource}"`,
    protectedResourceMetadata: () => METADATA
  }
}

function authorized(sub: string, namespaces: string[]): AuthOutcome {
  return {
    ok: true,
    caller: { sub, groups: [], namespaces },
    authInfo: {
      token: `token-${sub}`,
      clientId: 'test-client',
      scopes: [],
      extra: { sub, namespaces }
    }
  }
}

describe('HTTP transport authentication', () => {
  let httpServer: Server | undefined

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer?.close(error => (error ? reject(error) : resolve()))
      })
      httpServer = undefined
    }
  })

  async function start(outcomes: Map<string, AuthOutcome>): Promise<string> {
    const searchWorkloads = vi.fn().mockResolvedValue({
      query: 'api',
      matches: [],
      scope: { scoped: true, namespaces: [], note: null }
    })

    httpServer = await startHttpTransport(
      () =>
        createMcpServer({
          workloadSearchService: { searchWorkloads },
          imageUpdatePlanningService: { planImageUpdates: vi.fn() }
        }),
      { host: '127.0.0.1', port: 0, authenticator: authenticatorFor(outcomes) }
    )

    return `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`
  }

  const initializeBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' }
    }
  })

  const postHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
  }

  it('rejects an unauthenticated POST with a resource_metadata challenge', async () => {
    const baseUrl = await start(new Map())

    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: postHeaders,
      body: initializeBody
    })

    expect(response.status).toBe(401)
    // Without this header an OAuth-capable client cannot discover the flow.
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=')
  })

  it('serves RFC 9728 metadata unauthenticated at both spellings', async () => {
    const baseUrl = await start(new Map())

    for (const path of [PROTECTED_RESOURCE_METADATA_PATH, PROTECTED_RESOURCE_METADATA_ROOT_PATH]) {
      const response = await fetch(`${baseUrl}${path}`)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual(METADATA)
    }
  })

  it('refuses a session id presented by a different subject', async () => {
    // A session id is a bearer credential of its own. Reusing one across
    // subjects would let the second caller inherit the first one's tenancy.
    const outcomes = new Map<string, AuthOutcome>([
      ['token-alice', authorized('alice', ['sandbox-alice'])],
      ['token-bob', authorized('bob', ['sandbox-bob'])]
    ])
    const baseUrl = await start(outcomes)

    const initialize = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...postHeaders, authorization: 'Bearer token-alice' },
      body: initializeBody
    })

    expect(initialize.status).toBe(200)

    const sessionId = initialize.headers.get('mcp-session-id')

    expect(sessionId).toBeTruthy()

    const hijacked = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        ...postHeaders,
        authorization: 'Bearer token-bob',
        'mcp-session-id': sessionId as string
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    })

    expect(hijacked.status).toBe(403)
    await expect(hijacked.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('another subject') }
    })
  })

  it('lets the initializing subject keep using its own session', async () => {
    const outcomes = new Map<string, AuthOutcome>([['token-alice', authorized('alice', ['sandbox-alice'])]])
    const baseUrl = await start(outcomes)

    const initialize = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...postHeaders, authorization: 'Bearer token-alice' },
      body: initializeBody
    })
    const sessionId = initialize.headers.get('mcp-session-id') as string

    const listed = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { ...postHeaders, authorization: 'Bearer token-alice', 'mcp-session-id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    })

    expect(listed.status).toBe(200)
  })
})
