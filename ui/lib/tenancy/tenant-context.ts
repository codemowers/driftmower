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

export type TenantContextState = {
  // /api/tenants answered (successfully or not) for this session.
  hydrated: boolean
  // platform-manager is deployed and the tenant list loaded.
  available: boolean
  admin: boolean
  tenants: TenantInfo[]
  // The chosen tenant context; null = whole cluster.
  selectedTenant: string | null
  // A selection has been made (from the URL, the default, or the picker).
  initialized: boolean
}

export const useTenantContext = create<TenantContextState>(() => ({
  hydrated: false,
  available: false,
  admin: false,
  tenants: [],
  selectedTenant: null,
  initialized: false,
}))

let hydrationStarted = false

// Fetch the tenant list once per session; safe to call repeatedly.
export function hydrateTenantContext(): void {
  if (hydrationStarted) return
  hydrationStarted = true
  fetch("/api/tenants")
    .then(async res => {
      if (!res.ok) {
        // 404 = platform-manager not deployed, 401 = stale session; either
        // way there is no tenant context to offer.
        useTenantContext.setState({ hydrated: true, available: false })
        return
      }
      const body: { admin: boolean; tenants: TenantInfo[] } = await res.json()
      useTenantContext.setState({
        hydrated: true,
        available: true,
        admin: body.admin,
        tenants: body.tenants,
      })
    })
    .catch(() => useTenantContext.setState({ hydrated: true, available: false }))
}

// Non-admins with tenants land on their first tenant; admins and tenantless
// users land on the whole cluster.
export function defaultTenantSelection(state: TenantContextState): string | null {
  return !state.admin && state.tenants.length > 0 ? state.tenants[0].tenant : null
}

// Mirror the selection into ?tenant= (shallow, no re-navigation) so the
// context survives reloads and produces shareable deep links.
export function syncTenantParam(tenant: string | null): void {
  if (typeof window === "undefined") return
  const url = new URL(window.location.href)
  if (url.searchParams.get("tenant") === tenant) return
  if (tenant) url.searchParams.set("tenant", tenant)
  else url.searchParams.delete("tenant")
  window.history.replaceState(null, "", url)
}

// Select a tenant context (null = whole cluster).
export function selectTenant(tenant: string | null): void {
  useTenantContext.setState({ selectedTenant: tenant, initialized: true })
  syncTenantParam(tenant)
}

export type TenantScope = {
  tenant: string | null
  // Namespaces the selection covers; null = whole cluster (no filtering).
  namespaces: string[] | null
}

export function useTenantScope(): TenantScope {
  const selectedTenant = useTenantContext(s => s.selectedTenant)
  const tenants = useTenantContext(s => s.tenants)

  return useMemo(() => {
    if (!selectedTenant) return { tenant: null, namespaces: null }
    const tenant = tenants.find(t => t.tenant === selectedTenant)
    // An unknown tenant (stale deep link) scopes to nothing rather than
    // silently showing cluster-wide data.
    return {
      tenant: selectedTenant,
      namespaces: tenant ? [tenant.tenantNamespace, ...tenant.appNamespaces] : [],
    }
  }, [selectedTenant, tenants])
}
