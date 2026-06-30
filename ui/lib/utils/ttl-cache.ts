// Failures aren't cached; the next call retries.
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
