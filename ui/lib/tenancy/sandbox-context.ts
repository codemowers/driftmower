import { useMemo } from "react"
import { create } from "zustand"

// A sandbox is exactly one namespace. platform-manager used to model a tenant
// namespace plus 0..n application namespaces; it no longer does, and its API
// returns a single `namespace` per sandbox, so there is no namespace list here
// either.
export type SandboxInfo = {
  // The immutable id `<hash6>-<name>`: label value, URL segment, and the anchor
  // every ingress hostname in the sandbox must start with.
  sandbox: string
  // The user-chosen display name (the id minus its hash prefix).
  name: string
  namespace: string
  owners: string[]
  creator?: string
  stackChannel: string
}

export type SandboxUnavailableReason =
  | "not-configured"
  | "stale-session"
  | "unreachable"
  | "error"

export type SandboxContextState = {
  hydrated: boolean
  available: boolean
  unavailableReason: SandboxUnavailableReason | null
  admin: boolean
  sandboxes: SandboxInfo[]
  selectedSandboxes: string[]
  initialized: boolean
}

export const useSandboxContext = create<SandboxContextState>(() => ({
  hydrated: false,
  available: false,
  unavailableReason: null,
  admin: false,
  sandboxes: [],
  selectedSandboxes: [],
  initialized: false,
}))

function unavailableReasonFor(status: number): SandboxUnavailableReason {
  if (status === 404) return "not-configured"
  if (status === 401) return "stale-session"
  if (status === 503) return "unreachable"
  return "error"
}

export function hydrateSandboxContext(): void {
  if (useSandboxContext.getState().hydrated) return
  fetch("/api/sandboxes")
    .then(async res => {
      if (!res.ok) {
        useSandboxContext.setState({
          hydrated: true,
          available: false,
          unavailableReason: unavailableReasonFor(res.status),
        })
        return
      }
      const body: { admin: boolean; sandboxes: SandboxInfo[] } = await res.json()
      useSandboxContext.setState({
        hydrated: true,
        available: true,
        unavailableReason: null,
        admin: body.admin,
        sandboxes: body.sandboxes,
      })
    })
    .catch(() =>
      useSandboxContext.setState({
        hydrated: true,
        available: false,
        unavailableReason: "unreachable",
      }),
    )
}

export function defaultSandboxSelection(state: SandboxContextState): string[] {
  return !state.admin && state.sandboxes.length > 0 ? [state.sandboxes[0].sandbox] : []
}

export const SANDBOX_PARAM = "sandbox"
// Links bookmarked before the rename carry ?tenant=; reading it keeps them
// scoped instead of silently widening to the whole cluster.
export const LEGACY_SANDBOX_PARAM = "tenant"

export function readSandboxParam(params: URLSearchParams): string | null {
  return params.get(SANDBOX_PARAM) ?? params.get(LEGACY_SANDBOX_PARAM)
}

export function syncSandboxParam(sandboxes: string[]): void {
  if (typeof window === "undefined") return
  const value = sandboxes.join(",")
  const url = new URL(window.location.href)
  // Drop the legacy key on any write, so a link shared from here is canonical.
  url.searchParams.delete(LEGACY_SANDBOX_PARAM)
  if ((url.searchParams.get(SANDBOX_PARAM) ?? "") === value) {
    window.history.replaceState(null, "", url)
    return
  }
  if (value) url.searchParams.set(SANDBOX_PARAM, value)
  else url.searchParams.delete(SANDBOX_PARAM)
  window.history.replaceState(null, "", url)
}

export function selectSandboxes(sandboxes: string[]): void {
  useSandboxContext.setState({ selectedSandboxes: sandboxes, initialized: true })
  syncSandboxParam(sandboxes)
}

export function toggleSandbox(sandbox: string): void {
  const { selectedSandboxes } = useSandboxContext.getState()
  selectSandboxes(
    selectedSandboxes.includes(sandbox)
      ? selectedSandboxes.filter(s => s !== sandbox)
      : [...selectedSandboxes, sandbox],
  )
}

export type SandboxScope = {
  sandboxes: string[]
  label: string | null
  namespaces: string[] | null
}

export function useSandboxScope(): SandboxScope {
  const selectedSandboxes = useSandboxContext(s => s.selectedSandboxes)
  const sandboxes = useSandboxContext(s => s.sandboxes)

  return useMemo(() => {
    if (selectedSandboxes.length === 0) return { sandboxes: [], label: null, namespaces: null }

    // A stale deep link naming an unknown sandbox must scope to nothing, not widen
    // back to the cluster.
    const namespaces = selectedSandboxes.flatMap(id => {
      const sandbox = sandboxes.find(s => s.sandbox === id)
      return sandbox ? [sandbox.namespace] : []
    })

    return {
      sandboxes: selectedSandboxes,
      label:
        selectedSandboxes.length === 1
          ? selectedSandboxes[0]
          : `${selectedSandboxes.length} sandboxes`,
      namespaces: [...new Set(namespaces)],
    }
  }, [selectedSandboxes, sandboxes])
}
