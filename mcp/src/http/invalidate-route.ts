import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { readBearerToken } from '../auth/bearer.js'

// A second freshness channel beside the RBAC watch, for what a watch cannot
// see: a webhook authorizer whose policy changed, an operator who wants a
// flush, an Argo CD PostSync hook. Two ways to be allowed in: a shared secret,
// or a Kubernetes ServiceAccount token that a TokenReview resolves to one of
// the configured subjects.
export const INVALIDATE_PATH = '/api/cache/invalidate'

export interface InvalidateRouteDependencies {
  sharedToken: string | null
  allowedSubjects: string[]
  // POST /apis/authentication.k8s.io/v1/tokenreviews as the service account.
  tokenReview?: (token: string) => Promise<{ authenticated: boolean; username: string | null }>
  clearReviews: () => number
  invalidateNamespace: (namespace: string) => number
  invalidateIdentity: (sub: string) => number
  invalidateFacts: () => void
  onInvalidate?: (source: 'webhook', scope: string, cleared: number) => void
}

export async function handleInvalidateRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: InvalidateRouteDependencies
): Promise<void> {
  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'method_not_allowed' }, { allow: 'POST' })

    return
  }

  if (dependencies.sharedToken === null && dependencies.allowedSubjects.length === 0) {
    writeJson(response, 404, { error: 'not_found' })

    return
  }

  const token = readBearerToken(request.headers.authorization)

  if (!token) {
    writeJson(response, 401, {
      error: 'invalid_request',
      error_description: 'An Authorization: Bearer <token> header is required'
    })

    return
  }

  const caller = await authorise(token, dependencies)

  if (!caller) {
    writeJson(response, 403, {
      error: 'forbidden',
      error_description: 'The token is not accepted for cache invalidation'
    })

    return
  }

  let body: { scope?: string; namespace?: string; sub?: string }

  try {
    body = JSON.parse((await readBody(request)) || '{}') as typeof body
  } catch {
    writeJson(response, 400, { error: 'invalid_json' })

    return
  }

  let cleared: number
  let scope: string

  switch (body.scope) {
    case 'all':
      cleared = dependencies.clearReviews()
      dependencies.invalidateFacts()
      scope = 'all'
      break
    case 'namespace':
      if (!body.namespace) {
        writeJson(response, 400, { error: 'missing_namespace' })

        return
      }

      cleared = dependencies.invalidateNamespace(body.namespace)
      scope = `namespace=${body.namespace}`
      break
    case 'identity':
      if (!body.sub) {
        writeJson(response, 400, { error: 'missing_sub' })

        return
      }

      cleared = dependencies.invalidateIdentity(body.sub)
      scope = `identity=${body.sub}`
      break
    default:
      writeJson(response, 400, {
        error: 'invalid_scope',
        error_description: "scope must be 'all', 'namespace' or 'identity'"
      })

      return
  }

  dependencies.onInvalidate?.('webhook', `${scope} by ${caller}`, cleared)
  writeJson(response, 200, { cleared, scope: body.scope })
}

async function authorise(token: string, dependencies: InvalidateRouteDependencies): Promise<string | null> {
  if (dependencies.sharedToken !== null && safeEqual(token, dependencies.sharedToken)) return 'shared-token'

  if (dependencies.allowedSubjects.length > 0 && dependencies.tokenReview) {
    const review = await dependencies.tokenReview(token)

    if (review.authenticated && review.username && dependencies.allowedSubjects.includes(review.username))
      return review.username
  }

  return null
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)

  return left.length === right.length && timingSafeEqual(left, right)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)

    size += buffer.length

    if (size > 4096) throw new Error('Body too large')

    chunks.push(buffer)
  }

  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  response.end(JSON.stringify(body))
}
