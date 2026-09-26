import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client'

const routes = new Set([
  '/',
  '/mcp',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp'
])
const methods = new Set(['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS'])

export class ApplicationMetrics {
  readonly registry = new Registry()
  readonly sessions = new Counter({
    name: 'driftmower_mcp_sessions_total',
    help: 'MCP sessions initialized.',
    registers: [this.registry]
  })
  private readonly requests = new Counter({
    name: 'driftmower_http_requests_total',
    help: 'Completed or aborted HTTP requests.',
    labelNames: ['route', 'method', 'status', 'outcome'] as const,
    registers: [this.registry]
  })
  private readonly inFlight = new Gauge({
    name: 'driftmower_http_requests_in_flight',
    help: 'HTTP requests and streams still open.',
    registers: [this.registry]
  })
  private readonly latency = new Histogram({
    name: 'driftmower_http_request_duration_seconds',
    help: 'Time until the HTTP response completes or aborts, including stream lifetime.',
    labelNames: ['route', 'method'] as const,
    buckets: [0.005, 0.025, 0.1, 0.5, 1, 5, 15, 60],
    registers: [this.registry]
  })
  private readonly requestSize = new Histogram({
    name: 'driftmower_http_declared_request_size_bytes',
    help: 'Request body size when a valid Content-Length is supplied; chunked requests are omitted.',
    buckets: [128, 1024, 16384, 262144, 1048576],
    registers: [this.registry]
  })
  private readonly responseSize = new Histogram({
    name: 'driftmower_http_response_size_bytes',
    help: 'Response body bytes written by the application before completion or abort.',
    buckets: [128, 1024, 16384, 262144, 1048576],
    registers: [this.registry]
  })

  observe(request: IncomingMessage, response: ServerResponse): void {
    const path = (request.url ?? '/').split('?')[0]
    const labels = {
      route: routes.has(path) ? path : 'other',
      method: methods.has(request.method ?? '') ? request.method! : 'other'
    }
    const start = performance.now()
    const contentLength = request.headers['content-length']
    let responseBytes = 0
    let finished = false

    this.inFlight.inc()

    if (contentLength !== undefined && /^\d+$/.test(contentLength)) {
      const size = Number(contentLength)

      if (Number.isSafeInteger(size)) this.requestSize.observe(size)
    }

    // Preserve Node's overloaded signatures, return values and callbacks.
    // Instrument writes without buffering SSE responses or changing backpressure.
    const count = (args: unknown[]): void => {
      if (request.method === 'HEAD' || response.statusCode === 204 || response.statusCode === 304) return

      const [chunk, encoding] = args

      if (typeof chunk === 'string') {
        responseBytes += Buffer.byteLength(
          chunk,
          typeof encoding === 'string' && Buffer.isEncoding(encoding) ? encoding : 'utf8'
        )
      } else if (chunk instanceof Uint8Array) {
        responseBytes += chunk.byteLength
      }
    }

    response.write = new Proxy(response.write, {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args)

        count(args)

        return result
      }
    })
    response.end = new Proxy(response.end, {
      apply(target, receiver, args) {
        count(args)

        return Reflect.apply(target, receiver, args)
      }
    })
    const finish = (): void => {
      if (finished) return

      finished = true
      this.inFlight.dec()
      this.requests.inc({
        ...labels,
        status: String(response.statusCode),
        outcome: response.writableFinished ? 'complete' : 'aborted'
      })
      this.latency.observe(labels, (performance.now() - start) / 1000)
      this.responseSize.observe(responseBytes)
    }

    response.once('finish', finish)
    response.once('close', finish)
  }
}
