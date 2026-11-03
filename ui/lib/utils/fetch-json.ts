import { readApiError } from "./read-api-error"

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init })
  if (!res.ok) throw new Error(await readApiError(res))
  return (await res.json()) as T
}
