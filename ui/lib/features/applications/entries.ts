import type { ApplicationEntry } from "./types.ts"

export function registeredApplications(entries: ApplicationEntry[]): ApplicationEntry[] {
  const seen = new Set<string>()
  return entries.filter(entry => {
    const url = new URL(entry.url).href
    const key = `${entry.namespace}/${url}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function otherHosts(entries: ApplicationEntry[], registered: ApplicationEntry[]): ApplicationEntry[] {
  const seen = new Set(registered.map(entry => `${entry.namespace}/${new URL(entry.url).host}`))
  return [...entries].sort((a, b) => new URL(a.url).pathname.length - new URL(b.url).pathname.length).filter(entry => {
    if (entry.name.startsWith("cm-acme-http-solver-")) return false
    const key = `${entry.namespace}/${new URL(entry.url).host}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
