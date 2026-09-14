import type { CapabilityResponse, OfferingId } from '../domain/provisioning.js'

// Client for driftmower-ui's provisioning capability API.
//
// The caller's own bearer token is forwarded rather than a service credential,
// so the tenancy scoping driftmower-ui already applies to that route holds here
// too: a crafted `ns=` cannot read another sandbox's quota, because the answer
// to "may this caller see this namespace" is decided there, once, against the
// same token the MCP client presented.

export const CAPABILITIES_PATH = '/api/provisioning/capabilities'

export interface CapabilitiesQuery {
  namespaces?: string[]
  offering?: OfferingId
}

export type CapabilitiesResult =
  | { ok: true; capabilities: CapabilityResponse }
  // Named, actionable failure rather than a thrown stack trace: the provisioning
  // tools are a façade over another pod, and "driftmower-ui is unreachable" is a
  // different answer from "this cluster has no storage classes".
  | { ok: false; reason: 'unauthorized' | 'unreachable' | 'bad_response'; detail: string }

export interface DriftmowerUiClient {
  fetchCapabilities(accessToken: string | null, query?: CapabilitiesQuery): Promise<CapabilitiesResult>
}

export interface DriftmowerUiClientOptions {
  baseUrl: string
  requestTimeoutMs: number
  fetchImplementation?: typeof fetch
}

export function createDriftmowerUiClient(options: DriftmowerUiClientOptions): DriftmowerUiClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const fetchImplementation = options.fetchImplementation ?? fetch

  return {
    async fetchCapabilities(accessToken, query = {}) {
      const url = new URL(`${baseUrl}${CAPABILITIES_PATH}`)

      if (query.namespaces && query.namespaces.length > 0) {
        url.searchParams.set('ns', query.namespaces.join(','))
      }

      if (query.offering) {
        url.searchParams.set('offering', query.offering)
      }

      let response: Response

      try {
        response = await fetchImplementation(url, {
          headers: {
            accept: 'application/json',
            'cache-control': 'no-store',
            ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
          },
          signal: AbortSignal.timeout(options.requestTimeoutMs)
        })
      } catch (error) {
        return {
          ok: false,
          reason: 'unreachable',
          detail: `Could not reach driftmower-ui at ${baseUrl}: ${errorMessage(error)}`
        }
      }

      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          detail:
            `driftmower-ui refused this token (HTTP ${response.status}). ` +
            'The token must be accepted by driftmower-ui as well as by this server.'
        }
      }

      if (!response.ok) {
        return {
          ok: false,
          reason: 'bad_response',
          detail: `driftmower-ui returned HTTP ${response.status} for ${CAPABILITIES_PATH}`
        }
      }

      try {
        return { ok: true, capabilities: (await response.json()) as CapabilityResponse }
      } catch (error) {
        return {
          ok: false,
          reason: 'bad_response',
          detail: `driftmower-ui returned a body that is not JSON: ${errorMessage(error)}`
        }
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
