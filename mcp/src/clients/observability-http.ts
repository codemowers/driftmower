import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Buffer } from 'node:buffer'

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
