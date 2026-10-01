"use client"

import { useEffect, useState } from "react"
import { suffixFromAppBaseUrl } from "@/lib/features/provisioning/ingress-facts"
import { hostOf } from "./host-url"
import type { ApplicationEntry, HostsResponse, OidcApp, TenancyState } from "./types"
import { readApiError } from "@/lib/utils/read-api-error"

const REGISTERED_URL = "/api/applications/registered"
const HOSTS_URL = "/api/applications/hosts"

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

export type ApplicationsState = { launcher: LauncherState; inventory: InventoryState }

// Only the inventory narrows; the launcher is personal and stays whole.
export function scopedHosts(entries: ApplicationEntry[], namespaces: string[] | null): ApplicationEntry[] {
  if (!namespaces) return entries
  const scope = new Set(namespaces)
  return entries.filter(e => e.namespace !== null && scope.has(e.namespace))
}

async function fetchRegistered(): Promise<OidcApp[] | LauncherState> {
  const res = await fetch(REGISTERED_URL, { cache: "no-store" })

  if (res.status === 501 && res.headers.get("x-scope-not-configured")) {
    return { status: "scope-not-configured" }
  }
  if (res.status === 403 || res.status === 401) return { status: "stale-session" }
  if (!res.ok) return { status: "error", message: await readApiError(res) }

  const body: { apps: OidcApp[] } = await res.json()
  return body.apps
}

async function fetchHosts(): Promise<HostsResponse | { error: string }> {
  const res = await fetch(HOSTS_URL, { cache: "no-store" })
  if (!res.ok) return { error: await readApiError(res) }
  return (await res.json()) as HostsResponse
}

export function useApplications(): ApplicationsState {
  const [state, setState] = useState<ApplicationsState>({
    launcher: { status: "loading" },
    inventory: { status: "loading" },
  })

  useEffect(() => {
    let cancelled = false

    Promise.all([fetchRegistered(), fetchHosts()])
      .then(([registered, hosts]) => {
        if (cancelled) return

        const inventory: InventoryState = "error" in hosts
          ? { status: "error", message: hosts.error }
          : { status: "ready", entries: [], tenancy: hosts.tenancy }

        if (!Array.isArray(registered)) {
          setState({ launcher: registered, inventory })
          return
        }

        const hostList = "error" in hosts ? [] : hosts.hosts
        const byHost = new Map(hostList.map(h => [h.host, h]))
        const claimed = new Set<string>()

        const launcher: ApplicationEntry[] = registered.map(app => {
          const host = hostOf(app.url)
          const match = host ? byHost.get(host) : undefined
          if (match) claimed.add(match.host)

          return {
            key: `${app.name}-${app.url}`,
            name: app.name,
            url: app.url,
            namespace: match?.namespace ?? null,
            groups: app.groups,
            description: app.description,
            managerUID: match?.managerUID,
            argoApp: match?.argoApp,
          }
        })

        const others: ApplicationEntry[] = hostList
          .filter(h => !claimed.has(h.host))
          .map(h => ({
            key: h.host,
            name: h.name,
            url: h.url,
            namespace: h.namespace,
            groups: [],
            description: null,
            managerUID: h.managerUID,
            argoApp: h.argoApp,
          }))

        setState({
          launcher: { status: "ready", entries: launcher },
          inventory: "error" in hosts ? inventory : { status: "ready", entries: others, tenancy: hosts.tenancy },
        })
      })
      .catch((e: Error) => {
        if (cancelled) return
        setState({
          launcher: { status: "error", message: e.message },
          inventory: { status: "error", message: e.message },
        })
      })

    return () => {
      cancelled = true
    }
  }, [])

  return state
}

// The app is itself deployed at `<name>.<suffix>`, so its own location carries
// the cluster's domain suffix -- no cluster read and no extra round trip.
// Guarded for the server render, which has no location; the launcher is still
// loading then, so the two renders agree on what they draw either way.
export function useDomainSuffix(): string | null {
  const [suffix] = useState<string | null>(() =>
    typeof window === "undefined" ? null : suffixFromAppBaseUrl(window.location.origin),
  )

  return suffix
}
