// Fetch JSON with no caching, throwing on a non-2xx response. For callers that
// want to surface failures (vs. silently degrading) this removes the repeated
// fetch -> res.ok check -> res.json() boilerplate.
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init })
  if (!res.ok) throw new Error(`Request to ${url} failed: ${res.status}`)
  return (await res.json()) as T
}
