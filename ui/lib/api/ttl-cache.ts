// Memoize a single async value for `ttlMs`. Failures are not cached: if the
// loader throws, nothing is stored and the next call retries. Intended for
// module-scoped use in route handlers (e.g. ingress endpoint discovery).
export function createTtlCache<T>(ttlMs: number, loader: () => Promise<T>): () => Promise<T> {
  let cached: { value: T; expiresAt: number } | null = null
  return async () => {
    const now = Date.now()
    if (cached && cached.expiresAt > now) return cached.value
    const value = await loader()
    cached = { value, expiresAt: now + ttlMs }
    return value
  }
}
