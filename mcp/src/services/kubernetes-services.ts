import { WorkloadActions } from './workload-actions.js'
import { createWorkloadCache } from '../clients/workload-cache.js'
import { VolumeService } from './volume-service.js'
import {
  createBackendGateway,
  createCallerBudget,
  GuardRefused,
  type BackendOutcome,
  type CallerBudget,
  type GuardRefusal
} from '../clients/backend-guard.js'
import { createHttpRequester, createHttpStreamer } from '../clients/observability-http.js'
import { createRbacWatch, rbacWatchTargets, type RbacWatch } from '../clients/rbac-watch.js'
import { identityKey } from '../clients/cached-access.js'
import { createObservabilityKubernetes } from '../clients/observability-kubernetes.js'
import type {
  KubernetesConfig,
  ObservabilityConfig,
  ObservabilityGuardConfig,
  ProvisioningConfig,
  TenancyConfig
} from '../config.js'
import { ObservabilityService } from './observability-service.js'
import { ProvisioningService } from './provisioning-service.js'
import type { KubernetesIdentityMapping } from '../auth/kubernetes-identity.js'
import { createProvisioningFacts } from '../clients/provisioning-facts/index.js'

// Kubernetes discovery is always available, independently of monitoring URLs.
// Credentials and network access are needed only when a tool is called.
export function createKubernetesServices(
  config: KubernetesConfig,
  observability?: ObservabilityConfig | null,
  tenancy?: TenancyConfig | null,
  provisioning?: ProvisioningConfig | null,
  // The cluster's identity, read lazily because it is discovered after these
  // services exist (from the kubelogin Ingress they provide).
  clusterId?: () => string | null,
  workloadRestartEnabled = false,
  hooks: { onObservabilityGuard?: (outcome: BackendOutcome | GuardRefusal) => void } = {}
) {
  const kubernetes = createObservabilityKubernetes({
    url: config.url,
    tokenFile: config.tokenFile,
    caFile: config.caFile,
    request: createHttpRequester(config.requestTimeoutMs),
    stream: createHttpStreamer(config.requestTimeoutMs),
    sarCacheTtlMs: config.sarCacheTtlMs,
    scopeMaxNamespaces: tenancy?.maxNamespaces
  })
  const workloadCache = createWorkloadCache({
    read: kubernetes.read,
    watch: kubernetes.watch,
    allowed: kubernetes.allowed,
    namespaceScope: kubernetes.scopeResolver
  })
  // One guarded path to the shared Prometheus and Loki for every tool that
  // reads them, so their limits are counted together.
  const backend = observability
    ? {
        request: createBackendGateway({
          request: createHttpRequester(observability.requestTimeoutMs),
          prometheusUrl: observability.prometheusUrl,
          maxConcurrent: observability.guards.maxConcurrentRequests,
          maxQueued: observability.guards.maxQueuedRequests,
          // A queued request gives up within the same deadline a running one has.
          queueWaitMs: observability.requestTimeoutMs,
          cacheTtlMs: observability.guards.cacheTtlMs,
          // A second under the HTTP deadline, so Prometheus stops first.
          prometheusTimeoutSeconds: Math.max(1, Math.floor(observability.requestTimeoutMs / 1000) - 1),
          onOutcome: hooks.onObservabilityGuard
        }),
        budget: observabilityBudget(observability.guards, hooks.onObservabilityGuard)
      }
    : null
  const identityMapping: KubernetesIdentityMapping = {
    usernameClaim: config.usernameClaim,
    groupsClaim: config.groupsClaim,
    usernamePrefix: config.usernamePrefix,
    groupsPrefix: config.groupsPrefix
  }

  const facts = createProvisioningFacts({
    read: kubernetes.read,
    checker: kubernetes.accessChecker,
    catalog: kubernetes.catalog,
    capabilities: kubernetes.capabilities,
    ingressDomainSuffix: provisioning?.ingressDomainSuffix ?? null,
    clusterFactTtlMs: provisioning?.clusterFactTtlMs ?? 300_000,
    topologyTtlMs: provisioning?.topologyTtlMs ?? 60_000,
    operatorTtlMs: provisioning?.operatorTtlMs ?? 30_000,
    clusterId
  })
  const provisioningService = new ProvisioningService({
    facts,
    checker: kubernetes.accessChecker,
    maxNamespaces: provisioning?.maxNamespaces ?? 20
  })

  // Everything that can go stale, invalidated from one place so the watch and
  // the webhook agree on what a change means.
  const invalidation = {
    clearReviews: () => kubernetes.sarCache.clear(),
    invalidateNamespace: (namespace: string) => kubernetes.sarCache.invalidate({ namespace }),
    invalidateIdentity: (sub: string) =>
      kubernetes.sarCache.invalidate({
        identityKey: identityKey({ user: `${config.usernamePrefix}${sub}`, groups: [] })
      }),
    invalidateFacts: () => facts.invalidate(),
    namespacesChanged: () => kubernetes.invalidateNamespaceList()
  }
  const createWatch = (
    log: (message: string, metadata?: Record<string, unknown>) => void,
    onInvalidate?: (source: 'watch', what: string) => void
  ): RbacWatch =>
    createRbacWatch({
      targets: rbacWatchTargets({
        invalidateNamespace: namespace => {
          invalidation.invalidateNamespace(namespace)
          onInvalidate?.('watch', `namespace=${namespace}`)
        },
        clearReviews: () => {
          invalidation.clearReviews()
          onInvalidate?.('watch', 'all')
        },
        namespacesChanged: invalidation.namespacesChanged,
        discoveryChanged: () => {
          invalidation.invalidateFacts()
          onInvalidate?.('watch', 'discovery')
        }
      }),
      stream: path => kubernetes.watch(path),
      read: kubernetes.read,
      log
    })

  return {
    kubeloginIngress: kubernetes.kubeloginIngress,
    provisioning: { service: provisioningService, identityMapping },
    invalidation,
    createWatch,
    tokenReview: kubernetes.tokenReview,
    provisioningFacts: facts,
    clusterCatalog: kubernetes.catalog,
    clusterCapabilities: kubernetes.capabilities,
    podListing: { kubernetes, identityMapping },
    workloads: { service: workloadCache, identityMapping },
    ...(workloadRestartEnabled
      ? {
          workloadActions: {
            service: new WorkloadActions(kubernetes.callerRequest, name =>
              kubernetes.capabilities.describeCrd(name)
            ),
            identityMapping
          }
        }
      : {}),
    volumes: {
      service: new VolumeService({
        kubernetes,
        prometheusUrl: observability?.prometheusUrl ?? null,
        // The same guarded path as the metrics tools when observability is on.
        request: backend?.request ?? createHttpRequester(config.requestTimeoutMs),
        budget: backend?.budget
      }),
      identityMapping
    },
    namespaceScope: { resolver: kubernetes.scopeResolver, identityMapping },
    tenancy: {
      policy: tenancy?.scopeSource ?? 'union',
      resolver: kubernetes.scopeResolver,
      identityMapping
    },
    kubernetes,
    observability: observability
      ? {
          service: new ObservabilityService({
            prometheusUrl: observability.prometheusUrl,
            lokiUrl: observability.lokiUrl,
            request: backend!.request,
            budget: backend!.budget,
            queryTimeAlignmentMs: observability.guards.cacheTtlMs,
            kubernetes
          }),
          identityMapping
        }
      : undefined
  }
}

// The caller budget, reporting its own refusals alongside the gateway's outcomes.
function observabilityBudget(
  guards: ObservabilityGuardConfig,
  report?: (outcome: GuardRefusal) => void
): CallerBudget {
  const budget = createCallerBudget({
    queriesPerMinute: guards.queriesPerMinute,
    maxConcurrentCalls: guards.maxConcurrentCallsPerCaller
  })

  return {
    async admit(callerKey, call) {
      try {
        return await budget.admit(callerKey, call)
      } catch (error) {
        // Only refusals raised before the call ran; a call's own busy errors
        // were already reported by the gateway.
        if (error instanceof GuardRefused && error.reason !== 'busy') report?.(error.reason)

        throw error
      }
    }
  }
}
