import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportJWK, generateKeyPair, SignJWT, jwtVerify, type JSONWebKeySet } from 'jose'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createJwksResolver } from './jwks.js'

// A Kubernetes apiserver with --anonymous-auth=false serves /openid/v1/jwks
// only to authenticated callers. This stands in for it.
describe('createJwksResolver', () => {
  let privateKey: CryptoKey
  let keySet: JSONWebKeySet
  let server: Server | undefined
  let directory: string | undefined
  const seen: (string | undefined)[] = []

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true })

    privateKey = pair.privateKey
    keySet = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256' }] }
  })

  afterEach(async () => {
    seen.length = 0

    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))

    if (directory) await rm(directory, { recursive: true, force: true })

    server = undefined
    directory = undefined
  })

  async function start(accepted: string[]): Promise<string> {
    server = createServer((request, response) => {
      seen.push(request.headers.authorization)
      const ok = accepted.some(token => request.headers.authorization === `Bearer ${token}`)

      response.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
      response.end(JSON.stringify(ok ? keySet : { kind: 'Status', reason: 'Unauthorized' }))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))

    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/openid/v1/jwks`
  }

  const token = () =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('i')
      .setExpirationTime('5m')
      .sign(privateKey)

  it('fetches anonymously by default, which an authenticated-only issuer refuses', async () => {
    const url = await start(['sa-token'])

    await expect(jwtVerify(await token(), createJwksResolver(url))).rejects.toThrow('Expected 200 OK')
    expect(seen).toEqual([undefined])
  })

  it('presents the token file as a bearer credential and re-reads it on every fetch', async () => {
    directory = await mkdtemp(join(tmpdir(), 'jwks-'))
    const file = join(directory, 'token')

    await writeFile(file, 'sa-token\n')
    const url = await start(['sa-token', 'rotated'])

    await expect(
      jwtVerify(await token(), createJwksResolver(url, { bearerTokenFile: file }))
    ).resolves.toBeTruthy()
    // A fresh resolver after rotation reads the new token, not a cached one.
    await writeFile(file, 'rotated')
    await expect(
      jwtVerify(await token(), createJwksResolver(url, { bearerTokenFile: file }))
    ).resolves.toBeTruthy()
    expect(seen).toEqual(['Bearer sa-token', 'Bearer rotated'])
  })
})
