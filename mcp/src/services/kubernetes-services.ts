import { createHttpRequester } from '../clients/observability-http.js'
import { createObservabilityKubernetes } from '../clients/observability-kubernetes.js'
import type { KubernetesConfig, ObservabilityConfig } from '../config.js'
import { ObservabilityService } from './observability-service.js'

// Kubernetes discovery is always available, independently of monitoring URLs.
// Credentials and network access are needed only when a tool is called.
export function createKubernetesServices(
  config: KubernetesConfig,
  observability?: ObservabilityConfig | null
) {
  const kubernetes = createObservabilityKubernetes({
    url: config.url,
    tokenFile: config.tokenFile,
    caFile: config.caFile,
    namespaceRole: config.namespaceRole,
    request: createHttpRequester(config.requestTimeoutMs)
  })
  const identityMapping = { usernamePrefix: config.usernamePrefix, groupsPrefix: config.groupsPrefix }

  return {
    kubeloginIngress: kubernetes.kubeloginIngress,
    clusterCatalog: kubernetes.catalog,
    clusterCapabilities: kubernetes.capabilities,
    namespaceAccess: { service: kubernetes.namespaceAccess, identityMapping },
    observability: observability
      ? {
          service: new ObservabilityService({
            prometheusUrl: observability.prometheusUrl,
            lokiUrl: observability.lokiUrl,
            request: createHttpRequester(observability.requestTimeoutMs),
            kubernetes
          }),
          identityMapping
        }
      : undefined
  }
}
