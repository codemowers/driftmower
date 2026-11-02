import type { IncomingMessage, ServerResponse } from 'node:http'
import { kubernetesIdentityFor, type KubernetesIdentityMapping } from '../auth/kubernetes-identity.js'
import { writeChallenge, type BearerAuthenticator } from '../auth/bearer.js'
import { OFFERINGS_BY_ID } from '../domain/provisioning/catalog/offerings.js'
import type { OfferingId } from '../domain/provisioning/types.js'
import type { ProvisioningService } from '../services/provisioning-service.js'

// A plain JSON view of the capability layer, for driftmower-ui and any other
// consumer that is not an MCP client. Same authenticator, same audience, same
// tenancy decisions as the tools: the caller presents a token minted for this
// server, and every per-namespace answer is asked of the cluster authorizer as
// that caller.
export const CAPABILITIES_PATH = '/api/provisioning/capabilities'

export interface CapabilitiesRouteDependencies {
  service: Pick<ProvisioningService, 'capabilities' | 'maxNamespaces'>
  identityMapping: KubernetesIdentityMapping
  // Absent means the transport serves unauthenticated (in-cluster only);
  // permission verdicts then come back unknown rather than refused.
  authenticator?: BearerAuthenticator
  onAudit?: (line: string) => void
}

export async function handleCapabilitiesRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: CapabilitiesRouteDependencies
): Promise<void> {
  if (request.method !== 'GET') {
    writeJson(response, 405, { error: 'method_not_allowed' }, { allow: 'GET' })

    return
  }

  let identity = null
  let subject = 'anonymous'

  if (dependencies.authenticator) {
    const outcome = await dependencies.authenticator.authenticate(request.headers)

    if (!outcome.ok) {
      dependencies.onAudit?.(`[http] capabilities rejected: ${outcome.description}`)
      writeChallenge(response, dependencies.authenticator, outcome)

      return
    }

    subject = outcome.caller.sub
    const resolved = kubernetesIdentityFor(outcome.authInfo, dependencies.identityMapping)

    if (!resolved.ok) {
      writeJson(response, 403, { error: 'identity_unmappable', error_description: resolved.detail })

      return
    }

    identity = resolved.identity
  }

  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
  const namespaces = [
    ...new Set(
      (url.searchParams.get('ns') ?? '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean)
    )
  ]
  const offering = url.searchParams.get('offering')

  if (namespaces.length > dependencies.service.maxNamespaces) {
    writeJson(response, 400, {
      error: 'too_many_namespaces',
      error_description: `At most ${dependencies.service.maxNamespaces} namespaces per request`
    })

    return
  }

  // `summary` drops the raw per-resource matrix (hundreds of cells per
  // namespace) and keeps its counts and every derived verdict. The matrix is
  // still built either way; only its transfer is skipped.
  const accessDetail = url.searchParams.get('access') ?? 'full'

  if (accessDetail !== 'full' && accessDetail !== 'summary') {
    writeJson(response, 400, {
      error: 'unknown_access_detail',
      error_description: "access must be 'full' or 'summary'"
    })

    return
  }

  if (offering !== null && !OFFERINGS_BY_ID.has(offering as OfferingId)) {
    writeJson(response, 400, {
      error: 'unknown_offering',
      error_description: `No offering named ${offering}`
    })

    return
  }

  try {
    const body = await dependencies.service.capabilities(identity, {
      namespaces,
      offering: (offering as OfferingId | null) ?? undefined
    })

    dependencies.onAudit?.(
      `[http] capabilities sub=${subject} ns=${namespaces.join(',') || '-'} offering=${offering ?? '-'} withheld=${body.withheld.length}`
    )
    writeJson(
      response,
      200,
      accessDetail === 'summary'
        ? {
            ...body,
            namespaces: body.namespaces.map(fact =>
              fact.access ? { ...fact, access: withoutMatrix(fact.access) } : fact
            )
          }
        : body
    )
  } catch (error) {
    dependencies.onAudit?.(
      `[http] capabilities sub=${subject} error=${error instanceof Error ? error.message : String(error)}`
    )
    writeJson(response, 502, {
      error: 'kubernetes_unreachable',
      error_description: error instanceof Error ? error.message : String(error)
    })
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers
  })
  response.end(JSON.stringify(body))
}

function withoutMatrix<T extends { matrix: unknown }>(access: T): Omit<T, 'matrix'> {
  const { matrix, ...rest } = access

  void matrix

  return rest
}
