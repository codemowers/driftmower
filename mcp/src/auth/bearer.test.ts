import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { createBearerAuthenticator, protectedResourceMetadataPath } from './bearer.js'

const ISSUER = 'https://passmower.example/'
const PUBLIC_URL = 'https://driftmower-mcp.example.io'
const RESOURCE_PATH = '/mcp'
const RESOURCE = `${PUBLIC_URL}${RESOURCE_PATH}`

let privateKey: CryptoKey
let keySet: JSONWebKeySet
let keyId: string

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })

  privateKey = pair.privateKey
  keyId = 'test-key'
  keySet = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: keyId, alg: 'RS256' }] }
})

async function mintToken(audience: string, clientId = 'mcp-client') {
  return new SignJWT({ groups: [], client_id: clientId })
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject('user-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
}

function authenticator(audience?: string, allowedClientIds?: string[]) {
  return createBearerAuthenticator(
    { issuer: ISSUER, jwksUri: 'unused', audience, publicUrl: PUBLIC_URL, allowedClientIds },
    RESOURCE_PATH,
    createLocalJWKSet(keySet)
  )
}

describe('protectedResourceMetadata', () => {
  it('advertises the resource a client passes back as the RFC 8707 indicator', () => {
    expect(authenticator().protectedResourceMetadata()).toMatchObject({
      resource: RESOURCE,
      authorization_servers: [ISSUER]
    })
  })

  // Without this the authorization server issues no refresh token and the
  // connection dies an hour after every sign-in.
  it('offers offline_access so a client can refresh itself', () => {
    const metadata = authenticator().protectedResourceMetadata()

    expect(metadata.scopes_supported).toContain('offline_access')
  })

  it('points 401s at the document that carries it', () => {
    const header = authenticator().challengeHeader({
      ok: false,
      status: 401,
      error: 'invalid_token',
      description: 'nope'
    })

    expect(header).toContain(`resource_metadata="${PUBLIC_URL}${protectedResourceMetadataPath(RESOURCE_PATH)}"`)
  })
})

describe('audience', () => {
  // The bug this guards: the server advertised the URL as its resource but
  // verified `aud` against an unrelated literal, so a conformant client
  // completed OAuth and then 401'd on every call.
  it('accepts a token minted for the advertised resource when unconfigured', async () => {
    const outcome = await authenticator().authenticate({
      authorization: `Bearer ${await mintToken(RESOURCE)}`
    })

    expect(outcome.ok).toBe(true)
  })

  it('still rejects a token minted for another audience', async () => {
    const outcome = await authenticator().authenticate({
      authorization: `Bearer ${await mintToken('https://driftmower-api')}`
    })

    expect(outcome).toMatchObject({ ok: false, status: 401, error: 'invalid_token' })
  })

  it('honours an explicit audience over the advertised resource', async () => {
    const pinned = authenticator('https://driftmower-mcp')

    expect(await pinned.authenticate({ authorization: `Bearer ${await mintToken('https://driftmower-mcp')}` }))
      .toMatchObject({ ok: true })
    expect(await pinned.authenticate({ authorization: `Bearer ${await mintToken(RESOURCE)}` }))
      .toMatchObject({ ok: false, error: 'invalid_token' })
  })
})

describe('allowed clients', () => {
  // `aud` names this server, not the client: an authorization server minting
  // for any requested resource issues such a token to any of its clients.
  it('accepts any client when no list is configured', async () => {
    const outcome = await authenticator().authenticate({
      authorization: `Bearer ${await mintToken(RESOURCE, 'someone-elses-app')}`
    })

    expect(outcome.ok).toBe(true)
  })

  it('rejects a token issued to an unlisted client even when aud matches', async () => {
    const outcome = await authenticator(undefined, ['mcp-client']).authenticate({
      authorization: `Bearer ${await mintToken(RESOURCE, 'someone-elses-app')}`
    })

    expect(outcome).toMatchObject({ ok: false, status: 401, error: 'invalid_token' })
  })

  it('accepts a listed client', async () => {
    const outcome = await authenticator(undefined, ['mcp-client', 'web-ui']).authenticate({
      authorization: `Bearer ${await mintToken(RESOURCE, 'web-ui')}`
    })

    expect(outcome.ok).toBe(true)
  })
})
