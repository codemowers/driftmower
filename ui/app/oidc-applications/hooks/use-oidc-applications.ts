"use client"

import { useEffect, useState } from "react"

export type OidcApp = {
  name: string
  url: string
  groups: string[]
  displayOrder: number
  // Markdown pre-rendered to sanitized HTML by passmower.
  description: string | null
  metadata: unknown
}

export type FetchState =
  | { status: "loading" }
  | { status: "stale-session" }
  | { status: "error"; message: string }
  | { status: "ready"; apps: OidcApp[] }

export function useOidcApplications(): FetchState {
  const [state, setState] = useState<FetchState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false

    fetch("/api/oidc-applications")
      .then(async res => {
        if (cancelled) return
        if (res.status === 403) {
          setState({ status: "stale-session" })
          return
        }
        if (!res.ok) {
          setState({ status: "error", message: `Request failed with status ${res.status}` })
          return
        }
        const body: { apps: OidcApp[] } = await res.json()
        if (!cancelled) setState({ status: "ready", apps: body.apps })
      })
      .catch(e => {
        if (!cancelled) setState({ status: "error", message: String(e) })
      })

    return () => {
      cancelled = true
    }
  }, [])

  return state
}
