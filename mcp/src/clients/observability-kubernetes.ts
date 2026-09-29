import { createClusterCapabilities, type ClusterCapabilitiesDiscovery } from './cluster-capabilities.js'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { HttpRequester, HttpStream, HttpStreamer } from './observability-http.js'
import { createClusterCatalog, type ClusterCatalog } from './cluster-catalog.js'
import { createAccessChecker, type AccessChecker } from './access-check.js'
import { cachedAllowed, type SarCache } from './cached-access.js'
import { collect } from './kubernetes-list.js'
import { createRbacScopeResolver, type RbacScopeResolver } from './rbac-scope.js'
import { createTtlMemo } from './ttl-cache.js'

export class KubernetesApiError extends Error {
  constructor(readonly status: number) {
    super(`Kubernetes API returned HTTP ${status}`)
    this.name = 'KubernetesApiError'
  }
}

// A GET against the API with the service-account credentials. `accept` is for
// the few endpoints that negotiate a representation (aggregated discovery).
export type KubernetesReader = (path: string, accept?: string) => Promise<string>

export interface KubernetesIdentity {
  user: string
  groups: string[]
}

export interface AccessAttributes {
  namespace?: string
  verb: string
  group: string
  resource: string
  subresource?: string
  name?: string
}

const namespaceNameSchema = z.object({ metadata: z.object({ name: z.string() }) })

export interface ObservabilityKubernetes {
  allowed(identity: KubernetesIdentity, attributes: AccessAttributes): Promise<boolean>
  podLogs(namespace: string, pod: string, parameters: URLSearchParams): Promise<string>
}

// How long a namespace listing is reused across callers before it is re-read.
// Cheap to refresh, and a new namespace should not take an hour to appear.
const NAMESPACE_LIST_TTL_MS = 60_000

export function createObservabilityKubernetes(options: {
  url: string
  tokenFile: string
  caFile: string
  request: HttpRequester
  // Streaming requests for watches; absent means watches are unavailable.
  stream?: HttpStreamer
  // TTL of the SubjectAccessReview cache; 0 sends every review to the apiserver.
  sarCacheTtlMs?: number
  scopeMaxNamespaces?: number
}): ObservabilityKubernetes & {
  kubeloginIngress(): Promise<unknown>
  read: KubernetesReader
  catalog: ClusterCatalog
  capabilities: ClusterCapabilitiesDiscovery
  accessChecker: AccessChecker
  scopeResolver: RbacScopeResolver
  sarCache: SarCache
  listNamespaces(): Promise<string[]>
  invalidateNamespaceList(): void
  watch(path: string): Promise<HttpStream>
  tokenReview(token: string): Promise<{ authenticated: boolean; username: string | null }>
} {
  async function call(path: string, body?: unknown, accept = 'application/json'): Promise<string> {
    // Read on every call so projected service-account token rotation works.
    const [token, ca] = await Promise.all([
      readFile(options.tokenFile, 'utf8'),
      readFile(options.caFile, 'utf8')
    ])
    const response = await options.request({
      url: new URL(path, options.url),
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${token.trim()}`,
        'content-type': 'application/json',
        accept
      },
      ca,
      body: body ? JSON.stringify(body) : undefined
    })

    if (response.status < 200 || response.status >= 300) {
      throw new KubernetesApiError(response.status)
    }

    return response.body
  }

  const review: ObservabilityKubernetes['allowed'] = async (identity, attributes) => {
    const response = JSON.parse(
      await call('/apis/authorization.k8s.io/v1/subjectaccessreviews', {
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'SubjectAccessReview',
        spec: { ...identity, resourceAttributes: attributes }
      })
    ) as { status?: { allowed?: boolean; denied?: boolean; evaluationError?: string } }

    if (typeof response.status?.allowed !== 'boolean' || response.status.evaluationError) {
      throw new Error('Kubernetes access review was inconclusive')
    }

    return (
      response.status?.allowed === true && response.status.denied !== true && !response.status.evaluationError
    )
  }

  const { allowed, cache: sarCache } = cachedAllowed(review, { ttlMs: options.sarCacheTtlMs ?? 0 })
  const accessChecker = createAccessChecker(allowed)
  const read: KubernetesReader = (path, accept) => call(path, undefined, accept)
  const namespaceList = createTtlMemo(NAMESPACE_LIST_TTL_MS, () =>
    collect(read, '/api/v1/namespaces', item => namespaceNameSchema.parse(item).metadata.name, {
      what: 'Namespace listing'
    })
  )

  return {
    kubeloginIngress: async () =>
      JSON.parse(await call('/apis/networking.k8s.io/v1/namespaces/default/ingresses/kubelogin')),
    read,
    catalog: createClusterCatalog(path => call(path)),
    capabilities: createClusterCapabilities(path => call(path)),
    accessChecker,
    scopeResolver: createRbacScopeResolver({
      listNamespaces: () => namespaceList.get(),
      checker: accessChecker,
      maxNamespaces: options.scopeMaxNamespaces
    }),
    sarCache,
    listNamespaces: () => namespaceList.get(),
    invalidateNamespaceList: () => namespaceList.invalidate(),
    async watch(path) {
      if (!options.stream) throw new Error('Streaming requests are not configured')

      const [token, ca] = await Promise.all([
        readFile(options.tokenFile, 'utf8'),
        readFile(options.caFile, 'utf8')
      ])

      return options.stream({
        url: new URL(path, options.url),
        headers: { authorization: `Bearer ${token.trim()}`, accept: 'application/json' },
        ca
      })
    },
    async tokenReview(token) {
      const response = JSON.parse(
        await call('/apis/authentication.k8s.io/v1/tokenreviews', {
          apiVersion: 'authentication.k8s.io/v1',
          kind: 'TokenReview',
          spec: { token }
        })
      ) as { status?: { authenticated?: boolean; user?: { username?: string } } }

      return {
        authenticated: response.status?.authenticated === true,
        username: response.status?.user?.username ?? null
      }
    },
    allowed,
    podLogs(namespace, pod, parameters) {
      return call(
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${parameters}`
      )
    }
  }
}
