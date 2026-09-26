import { setTimeout } from 'node:timers'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { closeHttpServer } from './shutdown.js'

it('drains an in-flight request before closing', async () => {
  const server = createServer((_request, response) => {
    response.write('starting')
    setTimeout(() => response.end(' done'), 30)
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  const closing = closeHttpServer(server, 1000)

  expect(await response.text()).toBe('starting done')
  await closing
  expect(server.listening).toBe(false)
})

it('bounds shutdown when a streaming client remains connected', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: connected\n\n')
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  const body = expect(response.text()).rejects.toThrow()

  await closeHttpServer(server, 30)
  await body
  expect(server.listening).toBe(false)
})
