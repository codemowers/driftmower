import { useMemo } from "react"
import { create } from "zustand"

export type TenantInfo = {
  tenant: string
  tenantNamespace: string
  appNamespaces: string[]
  owners: string[]
  creator?: string
  stackChannel: string
}

export type TenantUnavailableReason =
  | "not-configured"
  | "stale-session"
  | "unreachable"
  | "error"

export type TenantContextState = {
  hydrated: boolean
  available: boolean
  unavailableReason: TenantUnavailableReason | null
  admin: boolean
  tenants: TenantInfo[]
  selectedTenants: string[]
  initialized: boolean
}

export const useTenantContext = create<TenantContextState>(() => ({
  hydrated: false,
  available: false,
  unavailableReason: null,
  admin: false,
  tenants: [],
  selectedTenants: [],
  initialized: false,
}))

function unavailableReasonFor(status: number): TenantUnavailableReason {
  if (status === 404) return "not-configured"
  if (status === 401) return "stale-session"
  if (status === 503) return "unreachable"
  return "error"
}

export function hydrateTenantContext(): void {
  if (useTenantContext.getState().hydrated) return
  fetch("/api/tenants")
    .then(async res => {
      if (!res.ok) {
        useTenantContext.setState({
          hydrated: true,
          available: false,
          unavailableReason: unavailableReasonFor(res.status),
        })
        return
      }
      const body: { admin: boolean; tenants: TenantInfo[] } = await res.json()
      useTenantContext.setState({
        hydrated: true,
        available: true,
        unavailableReason: null,
        admin: body.admin,
        tenants: body.tenants,
      })
    })
    .catch(() =>
      useTenantContext.setState({
        hydrated: true,
        available: false,
        unavailableReason: "unreachable",
      }),
    )
}

export function defaultTenantSelection(state: TenantContextState): string[] {
  return !state.admin && state.tenants.length > 0 ? [state.tenants[0].tenant] : []
}

export function syncTenantParam(tenants: string[]): void {
  if (typeof window === "undefined") return
  const value = tenants.join(",")
  const url = new URL(window.location.href)
  if ((url.searchParams.get("tenant") ?? "") === value) return
  if (value) url.searchParams.set("tenant", value)
  else url.searchParams.delete("tenant")
  window.history.replaceState(null, "", url)
}

export function selectTenants(tenants: string[]): void {
  useTenantContext.setState({ selectedTenants: tenants, initialized: true })
  syncTenantParam(tenants)
}

export function toggleTenant(tenant: string): void {
  const { selectedTenants } = useTenantContext.getState()
  selectTenants(
    selectedTenants.includes(tenant)
      ? selectedTenants.filter(t => t !== tenant)
      : [...selectedTenants, tenant],
  )
}

export type TenantScope = {
  tenants: string[]
  label: string | null
  namespaces: string[] | null
}

export function useTenantScope(): TenantScope {
  const selectedTenants = useTenantContext(s => s.selectedTenants)
  const tenants = useTenantContext(s => s.tenants)

  return useMemo(() => {
    if (selectedTenants.length === 0) return { tenants: [], label: null, namespaces: null }

    // A stale deep link naming an unknown tenant must scope to nothing, not widen back to the cluster.
    const namespaces = selectedTenants.flatMap(name => {
      const tenant = tenants.find(t => t.tenant === name)
      return tenant ? [tenant.tenantNamespace, ...tenant.appNamespaces] : []
    })

    return {
      tenants: selectedTenants,
      label:
        selectedTenants.length === 1
          ? selectedTenants[0]
          : `${selectedTenants.length} tenants`,
      namespaces: [...new Set(namespaces)],
    }
  }, [selectedTenants, tenants])
}
