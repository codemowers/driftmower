import { useSearchParams } from "next/navigation"

const CARRY = ["report", "filters", "q"] as const

export function useContextHref() {
  const searchParams = useSearchParams()
  const params = new URLSearchParams()
  for (const key of CARRY) {
    const value = searchParams.get(key)
    if (value) params.set(key, value)
  }
  const query = params.toString()
  const suffix = query ? `?${query}` : ""
  return { linkTo: (path: string) => `${path}${suffix}`, suffix }
}
