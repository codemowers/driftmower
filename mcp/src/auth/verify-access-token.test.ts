import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { verifyAccessToken } from './verify-access-token.js'

const ISSUER = 'https://passmower.example/'
const AUDIENCE = 'https://driftmower-mcp'
const NAMESPACES_CLAIM = 'codemowers.io/namespaces'

let privateKey: CryptoKey
let keySet: JSONWebKeySet
let keyId: string

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })

  privateKey = pair.privateKey

  const publicJwk = await exportJWK(pair.publicKey)

  keyId = 'test-key'
  keySet = { keys: [{ ...publicJwk, kid: keyId, alg: 'RS256' }] }
})

async function mintToken(claims: Record<string, unknown> = {}, overrides: Record<string, string> = {}) {
  return new SignJWT({ groups: ['platform'], [NAMESPACES_CLAIM]: ['sandbox-foo'], ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: keyId })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject(overrides.subject ?? 'user-1')
    .setIssuedAt()
    .setExpirationTime(overrides.expiry ?? '5m')
    .sign(privateKey)
}

describe('verifyAccessToken', () => {
  it('projects sub, groups and the tenancy claim', async () => {
    const token = await mintToken({ email: 'someone@example.com', name: 'Someone' })

    const { caller } = await verifyAccessToken(token, createLocalJWKSet(keySet), {
      issuer: ISSUER,
      audience: AUDIENCE
    })

    expect(caller).toEqual({
      sub: 'user-1',
      email: 'someone@example.com',
      name: 'Someone',
      groups: ['platform'],
      namespaces: ['sandbox-foo']
    })
  })

  it('rejects a token minted for another audience', async () => {
    // The check that proves the ordinary UI token cannot open this server.
    const token = await mintToken({}, { audience: 'https://driftmower-api' })

    await expect(
      verifyAccessToken(token, createLocalJWKSet(keySet), { issuer: ISSUER, audience: AUDIENCE })
    ).rejects.toThrow('unexpected "aud" claim value')
  })

  it('rejects a token from another issuer', async () => {
    const token = await mintToken({}, { issuer: 'https://elsewhere.example/' })

    await expect(
      verifyAccessToken(token, createLocalJWKSet(keySet), { issuer: ISSUER, audience: AUDIENCE })
    ).rejects.toThrow('unexpected "iss" claim value')
  })

  it('rejects an expired token', async () => {
    const token = await mintToken({}, { expiry: '-2h' })

    await expect(
      verifyAccessToken(token, createLocalJWKSet(keySet), { issuer: ISSUER, audience: AUDIENCE })
    ).rejects.toThrow(/exp/i)
  })

  it('leaves namespaces undefined when the token carries no tenancy claim', async () => {
    const token = await mintToken({ [NAMESPACES_CLAIM]: undefined })

    const { caller } = await verifyAccessToken(token, createLocalJWKSet(keySet), {
      issuer: ISSUER,
      audience: AUDIENCE
    })

    // Undefined, not []: the distinction is what lets scopeFromClaim tell a
    // misconfigured client from a caller entitled to nothing.
    expect(caller.namespaces).toBeUndefined()
    expect(caller.groups).toEqual(['platform'])
  })

  it('verifies against a published-JWKS-shaped key: kid present, alg absent', () => {
    // What passmower's /jwks actually serves. oidc-provider stamps the RFC 7638
    // thumbprint as `kid` when registering a key (initialize_keystore.js:
    // `key.kid ??= calculateKid(key)`), so the published document carries one
    // even though oidc-key-manager's configured key does not. It publishes no
    // `alg` for RSA, which must not stop RS256 verification.
    expect(keySet.keys[0].kid).toBeTruthy()

    return expect(
      (async () => {
        const published = { keys: [{ ...keySet.keys[0], alg: undefined }] } as JSONWebKeySet
        const token = await mintToken()
        const { caller } = await verifyAccessToken(token, createLocalJWKSet(published), {
          issuer: ISSUER,
          audience: AUDIENCE
        })

        return caller.sub
      })()
    ).resolves.toBe('user-1')
  })

  it('rejects a token with no sub claim', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: keyId })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)

    await expect(
      verifyAccessToken(token, createLocalJWKSet(keySet), { issuer: ISSUER, audience: AUDIENCE })
    ).rejects.toThrow('Token is missing a sub claim')
  })
})
