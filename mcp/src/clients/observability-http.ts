import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Buffer } from 'node:buffer'
import { clearTimeout, setTimeout } from 'node:timers'

export interface HttpRequest {
  url: URL
  method?: string
  headers?: Record<string, string>
  body?: string
  ca?: string
}

export interface HttpResponse {
  status: number
  body: string
}

export type HttpRequester = (request: HttpRequest) => Promise<HttpResponse>

// No redirects, bounded response size, and a deadline covering the entire body.
// Kubernetes uses its mounted CA, without weakening TLS for other services.
export function createHttpRequester(timeoutMs: number): HttpRequester {
  return async options =>
    new Promise((resolve, reject) => {
      const request = options.url.protocol === 'https:' ? httpsRequest : httpRequest
      const req = request(
        options.url,
        {
          method: options.method ?? 'GET',
          headers: options.headers,
          ca: options.ca,
          signal: AbortSignal.timeout(timeoutMs)
        },
        response => {
          const chunks: Buffer[] = []
          let size = 0

          response.on('data', (chunk: Buffer) => {
            size += chunk.length

            if (size > 4 * 1024 * 1024) {
              response.destroy(new Error('Observability response exceeds 4 MiB; narrow the query'))

              return
            }

            chunks.push(chunk)
          })
          response.on('error', reject)
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 502, body: Buffer.concat(chunks).toString('utf8') })
          )
        }
      )

      req.on('error', reject)
      req.end(options.body)
    })
}

export interface HttpStream {
  status: number
  // Newline-delimited body, one string per line, as the server sends them.
  lines: AsyncIterable<string>
  abort(): void
}

export type HttpStreamer = (request: HttpRequest) => Promise<HttpStream>

// A long-lived response read line by line, for Kubernetes watches. The
// connect phase has the deadline; the body deliberately has none, because a
// watch that receives no events for an hour is healthy. The caller owns the
// lifetime through `abort()`.
export function createHttpStreamer(connectTimeoutMs: number): HttpStreamer {
  return options =>
    new Promise((resolve, reject) => {
      const request = options.url.protocol === 'https:' ? httpsRequest : httpRequest
      const controller = new AbortController()
      let aborted = false
      const connectTimer = setTimeout(() => controller.abort(new Error('Connect timeout')), connectTimeoutMs)
      const req = request(
        options.url,
        {
          method: options.method ?? 'GET',
          headers: options.headers,
          ca: options.ca,
          signal: controller.signal
        },
        response => {
          clearTimeout(connectTimer)
          resolve({
            status: response.statusCode ?? 502,
            lines: readLines(response, () => aborted),
            abort: () => {
              aborted = true
              controller.abort(new Error('Stream aborted'))
            }
          })
        }
      )

      req.on('error', error => {
        clearTimeout(connectTimer)
        reject(error)
      })
      req.end(options.body)
    })
}

async function* readLines(
  source: AsyncIterable<Buffer | string>,
  wasAborted: () => boolean
): AsyncIterable<string> {
  let pending = ''

  try {
    for await (const chunk of source) {
      pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let index = pending.indexOf('\n')

      while (index >= 0) {
        const line = pending.slice(0, index).trim()

        pending = pending.slice(index + 1)

        if (line) yield line

        if (wasAborted()) return

        index = pending.indexOf('\n')
      }
    }
  } catch (error) {
    // The caller ended it; that is not a failure of the stream.
    if (wasAborted()) return

    throw error
  }

  if (pending.trim()) yield pending.trim()
}
