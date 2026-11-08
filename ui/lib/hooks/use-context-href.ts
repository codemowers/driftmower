import { useSearchParams } from "next/navigation"

// "tenant" is carried alongside "sandbox" so a link bookmarked before the
// rename keeps its scope; SandboxContextInit reads either, and any write
// emits only "sandbox".
const CARRY = ["sandbox", "tenant", "filters", "q", "focus", "wtab", "ptab", "htab"] as const

export type LinkTo = (path: string, opts?: { drop?: string[]; set?: Record<string, string> }) => string

export function useContextHref() {
  const searchParams = useSearchParams()

  const linkTo: LinkTo = (path, opts) => {
    const params = new URLSearchParams()
    for (const key of CARRY) {
      if (opts?.drop?.includes(key)) continue
      const value = searchParams.get(key)
      if (value) params.set(key, value)
    }
    for (const [key, value] of Object.entries(opts?.set ?? {})) params.set(key, value)
    const query = params.toString()
    return query ? `${path}?${query}` : path
  }

  return { linkTo, suffix: linkTo("") }
}
