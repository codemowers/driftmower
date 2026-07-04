import { useSearchParams } from "next/navigation"

const CARRY = ["report", "filters", "q", "wtab", "ptab", "htab"] as const

export type LinkTo = (path: string, opts?: { drop?: string[] }) => string

export function useContextHref() {
  const searchParams = useSearchParams()

  const linkTo: LinkTo = (path, opts) => {
    const params = new URLSearchParams()
    for (const key of CARRY) {
      if (opts?.drop?.includes(key)) continue
      const value = searchParams.get(key)
      if (value) params.set(key, value)
    }
    const query = params.toString()
    return query ? `${path}?${query}` : path
  }

  return { linkTo, suffix: linkTo("") }
}
