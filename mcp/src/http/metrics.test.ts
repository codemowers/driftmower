import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { ApplicationMetrics } from './metrics.js'
import { closeHttpServer } from './shutdown.js'

it('records streamed bytes and bounded labels without double counting completion', async () => {
  const metrics = new ApplicationMetrics()
  const server = createServer((request, response) => {
    metrics.observe(request, response)
    response.write('abc')
    response.end('de')
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/private-user-id?token=secret`,
      { method: 'POST', body: 'hi' }
    )

    expect(await response.text()).toBe('abcde')
    const output = await metrics.registry.metrics()

    expect(output).toContain(
      'driftmower_http_requests_total{route="other",method="POST",status="200",outcome="complete"} 1'
    )
    expect(output).toContain('driftmower_http_response_size_bytes_sum 5')
    expect(output).toContain('driftmower_http_declared_request_size_bytes_sum 2')
    expect(output).toContain('driftmower_http_requests_in_flight 0')
    expect(output).not.toContain('private-user-id')
    expect(output).not.toContain('secret')
  } finally {
    await closeHttpServer(server)
  }
})
