import { z } from 'zod'

const pageSchema = z.object({
  metadata: z.object({ continue: z.string().optional() }).optional(),
  items: z.array(z.unknown())
})

export interface CollectOptions {
  limit?: number
  maxPages?: number
  // Named in the error so an operator knows which listing outgrew the bound.
  what?: string
}

// Paged list over one Kubernetes collection. Refuses to return a partial
// result: a truncated namespace or policy list would read as "these are all",
// which is the wrong answer to give an agent.
export async function collect<T>(
  read: (path: string) => Promise<string>,
  path: string,
  project: (item: unknown) => T,
  options: CollectOptions = {}
): Promise<T[]> {
  const limit = options.limit ?? 500
  const maxPages = options.maxPages ?? 20
  const results: T[] = []
  let continuation = ''

  for (let page = 0; page < maxPages; page += 1) {
    const parameters = new URLSearchParams({ limit: String(limit) })

    if (continuation) parameters.set('continue', continuation)

    const separator = path.includes('?') ? '&' : '?'
    const result = pageSchema.parse(JSON.parse(await read(`${path}${separator}${parameters}`)))

    results.push(...result.items.map(project))
    continuation = result.metadata?.continue ?? ''

    if (!continuation) return results
  }

  throw new Error(
    `${options.what ?? 'Kubernetes listing'} exceeds ${maxPages} pages; refusing to return an incomplete list`
  )
}
