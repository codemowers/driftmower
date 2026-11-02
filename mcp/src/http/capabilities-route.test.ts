import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthOutcome, BearerAuthenticator, RejectedCall } from '../auth/bearer.js'
import { createMcpServer } from '../mcp/create-server.js'
import { startHttpTransport } from '../mcp/transports/http.js'
import type { ProvisioningService } from '../services/provisioning-service.js'
import { CAPABILITIES_PATH } from './capabilities-route.js'

const identityMapping = {
  usernameClaim: 'sub',
  groupsClaim: 'groups',
  usernamePrefix: 'issuer#',
  groupsPrefix: ''
}

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
      `Bearer error="${outcome.error}", resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp"`,
    protectedResourceMetadata: () => ({ resource: 'https://mcp.example/mcp' })
  }
}

const alice: AuthOutcome = {
  ok: true,
  caller: { sub: 'alice', groups: ['devs'], identityClaims: { username: 'alice', groups: ['devs'] } },
  authInfo: { token: 'token-alice', clientId: 'ui', scopes: [], extra: { sub: 'alice', groups: ['devs'] } }
}

function body(overrides: Record<string, unknown> = {}) {
  return {
    inCluster: true,
    offerings: [],
    storageClasses: [],
    topology: { zones: [], schedulableNodes: 1, controlPlaneLabel: null },
    namespaces: [],
    policies: [],
    admissionPolicies: [],
    ingress: {
      domainSuffix: null,
      domainSuffixSource: null,
      classes: [],
      clusterIssuers: [],
      tlsAdvice: '',
      hostRules: []
    },
    priorityClasses: [],
    networkPolicyEngine: 'native',
    monitoringOperator: false,
    degraded: [],
    withheld: [],
    ...overrides
  }
}

describe('GET /api/provisioning/capabilities', () => {
  let httpServer: Server | undefined

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve, reject) =>
        httpServer?.close(error => (error ? reject(error) : resolve()))
      )
      httpServer = undefined
    }
  })

  async function start(options: { authenticated?: boolean; capabilities?: ReturnType<typeof vi.fn> } = {}) {
    const capabilities = options.capabilities ?? vi.fn().mockResolvedValue(body())
    const service = { capabilities, maxNamespaces: 2 } as unknown as ProvisioningService

    httpServer = await startHttpTransport(() => createMcpServer({}), {
      host: '127.0.0.1',
      port: 0,
      authenticator:
        options.authenticated === false ? undefined : authenticatorFor(new Map([['token-alice', alice]])),
      capabilities: { service, identityMapping }
    })
    const { port } = httpServer.address() as AddressInfo

    return { base: `http://127.0.0.1:${port}`, capabilities }
  }

  it('challenges a missing or bad token with the RFC 6750 header and a JSON body', async () => {
    const { base } = await start()
    const response = await fetch(`${base}${CAPABILITIES_PATH}`)

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=')
    expect(await response.json()).toMatchObject({ error: 'invalid_token' })
  })

  it('answers as the mapped caller with the requested namespaces and offering, never cached', async () => {
    const { base, capabilities } = await start()
    const response = await fetch(`${base}${CAPABILITIES_PATH}?ns=a,%20b,a&offering=postgres`, {
      headers: { authorization: 'Bearer token-alice' }
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.json()).toMatchObject({ inCluster: true, withheld: [] })
    expect(capabilities).toHaveBeenCalledWith(
      { user: 'issuer#alice', groups: ['system:authenticated', 'devs'] },
      { namespaces: ['a', 'b'], offering: 'postgres' }
    )
  })

  it('drops the raw matrix on request and keeps every derived verdict', async () => {
    const fact = {
      namespace: 'a',
      access: { matrix: { '/pods': { list: 'yes' } }, view: 'yes', summary: { resourceTypes: 1 } },
      offerings: { postgres: { verdict: 'yes', reason: 'ok' } }
    }
    const { base } = await start({ capabilities: vi.fn().mockResolvedValue(body({ namespaces: [fact] })) })
    const headers = { authorization: 'Bearer token-alice' }
    const summary = (await (
      await fetch(`${base}${CAPABILITIES_PATH}?ns=a&access=summary`, { headers })
    ).json()) as {
      namespaces: { access: Record<string, unknown>; offerings: unknown }[]
    }
    const full = (await (
      await fetch(`${base}${CAPABILITIES_PATH}?ns=a`, { headers })
    ).json()) as typeof summary

    expect(summary.namespaces[0].access).toEqual({ view: 'yes', summary: { resourceTypes: 1 } })
    expect(summary.namespaces[0].offerings).toEqual({ postgres: { verdict: 'yes', reason: 'ok' } })
    expect(full.namespaces[0].access.matrix).toEqual({ '/pods': { list: 'yes' } })
    expect((await fetch(`${base}${CAPABILITIES_PATH}?access=some`, { headers })).status).toBe(400)
  })

  it('rejects too many namespaces, an unknown offering and other methods', async () => {
    const { base } = await start()
    const headers = { authorization: 'Bearer token-alice' }

    expect((await fetch(`${base}${CAPABILITIES_PATH}?ns=a,b,c`, { headers })).status).toBe(400)
    expect(
      await (await fetch(`${base}${CAPABILITIES_PATH}?offering=oracle`, { headers })).json()
    ).toMatchObject({ error: 'unknown_offering' })
    expect((await fetch(`${base}${CAPABILITIES_PATH}`, { method: 'POST', headers })).status).toBe(405)
  })

  it('serves an unauthenticated transport with no identity, so verdicts come back unknown rather than refused', async () => {
    const { base, capabilities } = await start({ authenticated: false })
    const response = await fetch(`${base}${CAPABILITIES_PATH}?ns=a`)

    expect(response.status).toBe(200)
    expect(capabilities).toHaveBeenCalledWith(null, { namespaces: ['a'], offering: undefined })
  })

  it('reports an unreadable Kubernetes API as 502 with the reason', async () => {
    const { base } = await start({ capabilities: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) })
    const response = await fetch(`${base}${CAPABILITIES_PATH}`, {
      headers: { authorization: 'Bearer token-alice' }
    })

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: 'kubernetes_unreachable',
      error_description: 'ECONNREFUSED'
    })
  })

  it('is a 404 when the route is not wired', async () => {
    httpServer = await startHttpTransport(() => createMcpServer({}), { host: '127.0.0.1', port: 0 })
    const { port } = httpServer.address() as AddressInfo

    expect((await fetch(`http://127.0.0.1:${port}${CAPABILITIES_PATH}`)).status).toBe(404)
  })
})
