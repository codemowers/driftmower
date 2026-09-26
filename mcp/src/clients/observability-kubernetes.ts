import { createClusterCapabilities, type ClusterCapabilitiesDiscovery } from './cluster-capabilities.js'
import { readFile } from 'node:fs/promises'
import type { HttpRequester } from './observability-http.js'
import { createClusterCatalog, type ClusterCatalog } from './cluster-catalog.js'
import { createNamespaceAccess, type NamespaceAccess } from './namespace-access.js'

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

export interface ObservabilityKubernetes {
  allowed(identity: KubernetesIdentity, attributes: AccessAttributes): Promise<boolean>
  podLogs(namespace: string, pod: string, parameters: URLSearchParams): Promise<string>
}

export function createObservabilityKubernetes(options: {
  url: string
  tokenFile: string
  caFile: string
  request: HttpRequester
  namespaceRole?: string
}): ObservabilityKubernetes & {
  kubeloginIngress(): Promise<unknown>
  catalog: ClusterCatalog
  namespaceAccess: NamespaceAccess
  capabilities: ClusterCapabilitiesDiscovery
} {
  async function call(path: string, body?: unknown): Promise<string> {
    // Read on every call so projected service-account token rotation works.
    const [token, ca] = await Promise.all([
      readFile(options.tokenFile, 'utf8'),
      readFile(options.caFile, 'utf8')
    ])
    const response = await options.request({
      url: new URL(path, options.url),
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token.trim()}`, 'content-type': 'application/json' },
      ca,
      body: body ? JSON.stringify(body) : undefined
    })

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Kubernetes API returned HTTP ${response.status}`)
    }

    return response.body
  }

  const allowed: ObservabilityKubernetes['allowed'] = async (identity, attributes) => {
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

  return {
    kubeloginIngress: async () =>
      JSON.parse(await call('/apis/networking.k8s.io/v1/namespaces/default/ingresses/kubelogin')),
    catalog: createClusterCatalog(path => call(path)),
    capabilities: createClusterCapabilities(path => call(path)),
    namespaceAccess: createNamespaceAccess(path => call(path), allowed, options.namespaceRole ?? 'admin'),
    allowed,
    podLogs(namespace, pod, parameters) {
      return call(
        `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/log?${parameters}`
      )
    }
  }
}
