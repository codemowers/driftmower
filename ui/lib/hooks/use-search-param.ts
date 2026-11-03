"use client"

import { useRouter, useSearchParams } from "next/navigation"

export function useSearchParam(key: string) {
  const router = useRouter()
  const searchParams = useSearchParams()

  function setValue(value: string | null) {
    const params = new URLSearchParams(searchParams.toString())
    if (value) params.set(key, value)
    else params.delete(key)
    const next = params.toString()
    router.replace(next ? `?${next}` : window.location.pathname, { scroll: false })
  }

  return [searchParams.get(key), setValue] as const
}
