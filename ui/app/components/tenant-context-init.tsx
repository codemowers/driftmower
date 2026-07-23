"use client"

import { useEffect } from "react"
import { useSearchParams } from "next/navigation"
import {
  defaultTenantSelection,
  hydrateTenantContext,
  syncTenantParam,
  useTenantContext,
} from "@/lib/tenancy/tenant-context"

// Bridges the ?tenant= URL contract and the tenant-context store:
// - hydrates the tenant list once per session,
// - lets ?tenant=<name> (platform-manager deep links) drive the selection,
// - applies the default selection when the URL carries no tenant,
// - re-mirrors the in-store selection after navigations that dropped the param.
export default function TenantContextInit() {
  const searchParams = useSearchParams()
  const tenantParam = searchParams.get("tenant")
  const hydrated = useTenantContext(s => s.hydrated)

  useEffect(() => {
    hydrateTenantContext()
  }, [])

  useEffect(() => {
    const state = useTenantContext.getState()

    // The URL is the source of truth whenever it names a tenant.
    if (tenantParam) {
      if (state.selectedTenant !== tenantParam || !state.initialized) {
        useTenantContext.setState({ selectedTenant: tenantParam, initialized: true })
      }
      return
    }

    // No ?tenant= in the URL: keep the store selection across navigation and
    // put it back into the URL for reloads/sharing.
    if (state.initialized) {
      if (state.selectedTenant) syncTenantParam(state.selectedTenant)
      return
    }

    // First load without a deep link: pick the default once tenants are known.
    if (!hydrated) return
    const fallback = defaultTenantSelection(state)
    useTenantContext.setState({ selectedTenant: fallback, initialized: true })
    if (fallback) syncTenantParam(fallback)
  }, [tenantParam, hydrated])

  return null
}
