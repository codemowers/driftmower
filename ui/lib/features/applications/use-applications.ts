"use client"

import { callTool } from "@/browser/connection"
import { useEffect,useState } from "react"
import { otherHosts,registeredApplications } from "./entries"
import type { ApplicationEntry } from "./types"

export type LauncherState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: ApplicationEntry[] }

export type InventoryState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: ApplicationEntry[] }

export type ApplicationsState = { launcher: LauncherState; inventory: InventoryState; warnings: string[] }

// Both lists can be narrowed by the current namespace selection.
export function scopedHosts(entries: ApplicationEntry[], namespaces: string[] | null): ApplicationEntry[] {
  if (!namespaces) return entries
  const scope = new Set(namespaces)
  return entries.filter(e => e.namespace !== null && scope.has(e.namespace))
}

export function useApplications(): ApplicationsState {
  const [state, setState] = useState<ApplicationsState>({
    launcher: { status: "loading" }, inventory: { status: "loading" }, warnings: [],
  })
  useEffect(() => {
    let cancelled = false
    const update = async () => {
      try {
        const result = await callTool<{oidcClients: ApplicationEntry[]; warnings: string[]}>("list_oidc_clients")
        if (!cancelled) setState({
          launcher: {status: "ready", entries: registeredApplications(result.oidcClients)},
          inventory: {status:"loading"}, warnings: result.warnings,
        })
        try {
          const hosts = await callTool<{applications: ApplicationEntry[]; warnings: string[]}>("list_applications")
          if (!cancelled) setState(state => ({...state,
            inventory: {status: "ready", entries: otherHosts(hosts.applications, result.oidcClients)},
            warnings: [...state.warnings, ...hosts.warnings],
          }))
        } catch (error) {
          if (!cancelled) setState(state => ({...state, inventory: {status:"error", message:(error as Error).message}}))
        }
      } catch (error) {
        if (!cancelled) setState({launcher:{status:"error",message:(error as Error).message},inventory:{status:"loading"},warnings:[]})
      }
    }
    void update()
    const timer = setInterval(update, 300_000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])
  return state
}
