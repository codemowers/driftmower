"use client"

import { useEffect, useState } from "react"

import { CAPABILITIES_URL } from "./constants"
import type { CapabilityResponse } from "./types"

export type CapabilityState =
  | { status: "loading" }
  | { status: "not-in-cluster" }
  | { status: "unauthenticated" }
  | { status: "error"; message: string }
  | { status: "ready"; capabilities: CapabilityResponse }

// Namespace-scoped facts (quota, host rule, pull secrets) are only read for the
// namespaces asked for, so the caller passes its sandbox scope in.
export function useCapabilities(namespaces: string[]): CapabilityState {
  const [state, setState] = useState<CapabilityState>({ status: "loading" })
  // Joined so the effect re-runs on a real change, not on a new array identity.
  const key = namespaces.join(",")

  useEffect(() => {
    let cancelled = false
    const query = key ? `?ns=${encodeURIComponent(key)}` : ""

    fetch(`${CAPABILITIES_URL}${query}`, { cache: "no-store" })
      .then(async res => {
        if (cancelled) return
        if (res.status === 401) {
          setState({ status: "unauthenticated" })
          return
        }
        const body = await res.json()
        if (!res.ok) {
          setState({ status: "error", message: body.error ?? `Request failed with status ${res.status}` })
          return
        }
        const capabilities = body as CapabilityResponse
        setState(
          capabilities.inCluster
            ? { status: "ready", capabilities }
            : { status: "not-in-cluster" },
        )
      })
      .catch(e => {
        if (!cancelled) setState({ status: "error", message: String(e) })
      })

    return () => {
      cancelled = true
    }
  }, [key])

  return state
}
