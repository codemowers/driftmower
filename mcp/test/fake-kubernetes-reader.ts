import { KubernetesApiError } from '../src/clients/observability-kubernetes.js'

// A path-prefix router for Kubernetes reads: fixtures answer, `403`/`404`
// entries throw the matching KubernetesApiError, and anything unrouted throws
// so a test cannot accidentally pass on an unexpected read.
export type ReaderRoute = unknown | 403 | 404 | ((path: string, accept?: string) => unknown)

export function fakeReader(routes: Record<string, ReaderRoute>) {
  const calls: { path: string; accept?: string }[] = []
  const read = async (path: string, accept?: string): Promise<string> => {
    calls.push({ path, accept })
    const key = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find(prefix => path === prefix || path.startsWith(prefix))

    if (key === undefined) throw new Error(`Unexpected read: ${path}`)

    const route = routes[key]

    if (route === 403 || route === 404) throw new KubernetesApiError(route)

    const body =
      typeof route === 'function' ? (route as (p: string, a?: string) => unknown)(path, accept) : route

    return JSON.stringify(body)
  }

  return { read, calls }
}

export const list = (items: unknown[]) => ({ items })
