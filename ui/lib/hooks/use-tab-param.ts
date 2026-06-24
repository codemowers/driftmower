import { useRouter, useSearchParams } from "next/navigation"

export function useTabParam<T extends string>(key: string, tabs: readonly T[]) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const param = searchParams.get(key)?.toLowerCase()
  const active = tabs.find(t => t.toLowerCase() === param) ?? tabs[0]

  function setActive(tab: T) {
    const params = new URLSearchParams(searchParams.toString())
    if (tab === tabs[0]) params.delete(key)
    else params.set(key, tab.toLowerCase())
    const next = params.toString()
    router.replace(next ? `?${next}` : window.location.pathname, { scroll: false })
  }

  return [active, setActive] as const
}
