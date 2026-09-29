import type {
  AccessAttributes,
  KubernetesIdentity,
  ObservabilityKubernetes
} from './observability-kubernetes.js'
import { createTtlCache } from './ttl-cache.js'

// One cache under every SubjectAccessReview this server sends.
//
// A review answer is a boolean for one (identity, verb, resource, namespace)
// tuple, so even a large fleet of callers and namespaces stays small in memory.
// Caching here rather than in each consumer means the scope sweep, the access
// matrix and the exact per-action checks agree with each other inside a window,
// and there is exactly one place that decides how stale an answer may be.
//
// Only conclusive answers are stored. A review the apiserver could not evaluate
// (webhook authorizer down, dangling role reference) throws, is not cached, and
// is retried on the next call.
//
// Freshness is meant to come from invalidation (RBAC watch, webhook), with the
// TTL as the safety net. This server never applies anything, so a permission
// revoked inside the window costs at most a 403 the caller's own kubectl
// reports and this server did not predict.

export type Allowed = ObservabilityKubernetes['allowed']

export interface SarCacheOptions {
  ttlMs: number
  maxEntries?: number
  now?: () => number
}

export interface SarCache {
  invalidate(filter: { namespace?: string; identityKey?: string }): number
  clear(): number
  size(): number
}

interface CachedAnswer {
  allowed: boolean
  namespace: string
  identityKey: string
}

export function identityKey(identity: KubernetesIdentity): string {
  return `${identity.user}\u0000${[...identity.groups].sort().join(',')}`
}

function attributesKey(attributes: AccessAttributes): string {
  return [
    attributes.namespace ?? '',
    attributes.group,
    attributes.resource,
    attributes.subresource ?? '',
    attributes.name ?? '',
    attributes.verb
  ].join('\u0000')
}

export function cachedAllowed(
  allowed: Allowed,
  options: SarCacheOptions
): { allowed: Allowed; cache: SarCache } {
  const cache = createTtlCache<CachedAnswer>({
    ttlMs: options.ttlMs,
    maxEntries: options.maxEntries ?? 50_000,
    now: options.now
  })
  const inFlight = new Map<string, Promise<boolean>>()
  const enabled = options.ttlMs > 0

  const wrapped: Allowed = async (identity, attributes) => {
    if (!enabled) return allowed(identity, attributes)

    const subject = identityKey(identity)
    const key = `${subject}\u0000${attributesKey(attributes)}`
    const hit = cache.get(key)

    if (hit) return hit.allowed

    const pending = inFlight.get(key)

    if (pending) return pending

    const review = allowed(identity, attributes).then(
      answer => {
        inFlight.delete(key)
        cache.set(key, { allowed: answer, namespace: attributes.namespace ?? '', identityKey: subject })

        return answer
      },
      error => {
        inFlight.delete(key)
        throw error
      }
    )

    inFlight.set(key, review)

    return review
  }

  return {
    allowed: wrapped,
    cache: {
      invalidate(filter) {
        return cache.deleteWhere(
          (_key, value) =>
            (filter.namespace === undefined || value.namespace === filter.namespace) &&
            (filter.identityKey === undefined || value.identityKey === filter.identityKey)
        )
      },
      clear: () => cache.clear(),
      size: () => cache.size()
    }
  }
}
