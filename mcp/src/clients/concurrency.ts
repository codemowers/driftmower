// Bounded parallel map that preserves input order. Used for fan-outs against
// the Kubernetes API where one call must not turn into thousands of concurrent
// requests, but serial execution would be needlessly slow.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next

      next += 1
      results[index] = await fn(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))

  return results
}
