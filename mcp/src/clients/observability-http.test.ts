import { setTimeout } from 'node:timers'
import { createServer, type Server, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createHttpRequester, createHttpStreamer } from './observability-http.js'

describe('observability HTTP transport', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server!.close(() => resolve()))
    }
  })

  async function start(handler: RequestListener): Promise<URL> {
    server = createServer(handler)
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))

    return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  }

  it('returns status and body without following redirects', async () => {
    let requests = 0
    const url = await start((_request, response) => {
      requests += 1
      response.writeHead(302, { location: '/another-service' })
      response.end('redirect')
    })

    expect(await createHttpRequester(1000)({ url })).toEqual({ status: 302, body: 'redirect' })
    expect(requests).toBe(1)
  })

  it('bounds the full body, including a response that never finishes', async () => {
    const url = await start((_request, response) => {
      response.writeHead(200)
      response.write('partial')
    })

    await expect(createHttpRequester(50)({ url })).rejects.toThrow()
  })

  it('rejects responses larger than the memory budget', async () => {
    const url = await start((_request, response) => response.end('x'.repeat(4 * 1024 * 1024 + 1)))

    await expect(createHttpRequester(1000)({ url })).rejects.toThrow('exceeds 4 MiB')
  })

  it('streams a chunked body line by line and stops when aborted', async () => {
    const url = await start((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.write('{"type":"ADDED"}\n{"type":"BOO')
      setTimeout(() => response.write('KMARK"}\n'), 20)
      // Never ends on its own; the client owns the lifetime.
    })
    const stream = await createHttpStreamer(1000)({ url })
    const seen: string[] = []

    expect(stream.status).toBe(200)

    for await (const line of stream.lines) {
      seen.push(line)

      if (seen.length === 2) stream.abort()
    }

    expect(seen).toEqual(['{"type":"ADDED"}', '{"type":"BOOKMARK"}'])
  })

  it('applies the deadline only to the connect phase', async () => {
    const url = await start((_request, response) => {
      setTimeout(() => {
        response.writeHead(200)
        response.end('late\n')
      }, 150)
    })

    await expect(createHttpStreamer(50)({ url })).rejects.toThrow()
  })
})
