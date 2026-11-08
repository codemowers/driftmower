"use client"

import { useEffect, useState } from "react"
import { suffixFromAppBaseUrl } from "@/lib/features/provisioning/ingress-facts"
import type { ApplicationEntry, TenancyState } from "./types"
import { callTool } from "@/browser/connection"

export type LauncherState =
  | { status: "loading" }
  | { status: "stale-session" }
  | { status: "scope-not-configured" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: ApplicationEntry[] }

export type InventoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: ApplicationEntry[]; tenancy: TenancyState }

// domainSuffix: the cluster's hosting domain as the server configured it, or
// null when it did not (see useDomainSuffix).
export type ApplicationsState = { launcher: LauncherState; inventory: InventoryState; domainSuffix: string | null }

// Only the inventory narrows; the launcher is personal and stays whole.
export function scopedHosts(entries: ApplicationEntry[], namespaces: string[] | null): ApplicationEntry[] {
  if (!namespaces) return entries
  const scope = new Set(namespaces)
  return entries.filter(e => e.namespace !== null && scope.has(e.namespace))
}

export function useApplications(): ApplicationsState {
  const [state, setState] = useState<ApplicationsState>({
    launcher: { status: "loading" }, inventory: { status: "loading" }, domainSuffix: null,
  })
  useEffect(() => {
    let cancelled = false
    const update = async () => {
      try {
        const result = await callTool<{applications: ApplicationEntry[]; warnings: string[]}>("list_applications")
        if (!cancelled) setState({
          launcher: {status: "ready", entries: result.applications},
          inventory: result.warnings.length ? {status:"error", message:result.warnings.join(" ")} : {status:"ready", entries:[], tenancy:"ok"},
          domainSuffix: null,
        })
      } catch (error) {
        if (!cancelled) setState({launcher:{status:"error",message:(error as Error).message},inventory:{status:"error",message:(error as Error).message},domainSuffix:null})
      }
    }
    void update()
    const timer = setInterval(update, 300_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])
  return state
}

// The configured suffix wins. Without one, fall back to the app's own
// location, assuming it is deployed at `<name>.<suffix>`; that is wrong for a
// deployment under a namespace label (dashboard.driftmower.<region>), which is
// why clusters set DOMAIN_SUFFIX. Guarded for the server render, which has no
// location; the launcher is still loading then, so both renders agree.
export function useDomainSuffix(configured: string | null): string | null {
  const [derived] = useState<string | null>(() =>
    typeof window === "undefined" ? null : suffixFromAppBaseUrl(window.location.origin),
  )

  return configured ?? derived
}
