// Small in-memory caches with a time bound. Nothing here is persistent or
// shared between processes; a restart starts cold.

export interface TtlCacheOptions {
  ttlMs: number
  maxEntries: number
  now?: () => number
}

export interface TtlCache<V> {
  get(key: string): V | undefined
  set(key: string, value: V, ttlMs?: number): void
  delete(key: string): boolean
  // Removes every entry the predicate selects and reports how many.
  deleteWhere(predicate: (key: string, value: V) => boolean): number
  clear(): number
  size(): number
}

interface Entry<V> {
  value: V
  expiresAt: number
}

// Least-recently-used by Map insertion order: a hit re-inserts the entry so
// eviction removes the coldest key first.
export function createTtlCache<V>(options: TtlCacheOptions): TtlCache<V> {
  const now = options.now ?? Date.now
  const entries = new Map<string, Entry<V>>()

  return {
    get(key) {
      const entry = entries.get(key)

      if (!entry) return undefined

      if (entry.expiresAt <= now()) {
        entries.delete(key)

        return undefined
      }

      entries.delete(key)
      entries.set(key, entry)

      return entry.value
    },
    set(key, value, ttlMs = options.ttlMs) {
      entries.delete(key)
      entries.set(key, { value, expiresAt: now() + ttlMs })

      while (entries.size > options.maxEntries) {
        const oldest = entries.keys().next().value

        if (oldest === undefined) break

        entries.delete(oldest)
      }
    },
    delete(key) {
      return entries.delete(key)
    },
    deleteWhere(predicate) {
      let removed = 0

      for (const [key, entry] of entries) {
        if (predicate(key, entry.value)) {
          entries.delete(key)
          removed += 1
        }
      }

      return removed
    },
    clear() {
      const size = entries.size

      entries.clear()

      return size
    },
    size() {
      return entries.size
    }
  }
}

export interface TtlMemo<T> {
  get(): Promise<T>
  invalidate(): void
}

// Single-value memo. Concurrent callers share the in-flight load, and a
// rejected load is not remembered, so the next call retries rather than
// serving a cached failure.
export function createTtlMemo<T>(
  ttlMs: number,
  load: () => Promise<T>,
  now: () => number = Date.now
): TtlMemo<T> {
  let value: { result: T; expiresAt: number } | null = null
  let pending: Promise<T> | null = null

  return {
    async get() {
      if (value && value.expiresAt > now()) return value.result

      if (!pending) {
        pending = load().then(
          result => {
            value = { result, expiresAt: now() + ttlMs }
            pending = null

            return result
          },
          error => {
            pending = null
            throw error
          }
        )
      }

      return pending
    },
    invalidate() {
      value = null
    }
  }
}
