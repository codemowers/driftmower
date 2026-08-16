"use client"

import { useEffect, useMemo, useState } from "react"
import { useParams } from "next/navigation"
import { Building2, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import Breadcrumbs from "../../components/breadcrumbs"
import RefreshButton from "../../components/core/refresh-button"
import { FilterSearchInput } from "../../components/filter-bar"
import { ValuePill } from "../components/overflow-pills"
import KubeconfigPanel from "../kubeconfig-panel"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { cn } from "@/lib/utils/cn"
import { hydrateTenantContext, toggleTenant, useTenantContext } from "@/lib/tenancy/tenant-context"

const FILTER_THRESHOLD = 24

export default function TenantDetailPage() {
  const params = useParams<{ tenant: string }>()
  const name = decodeURIComponent(params.tenant)
  const [query, setQuery] = useState("")
  const hydrated = useTenantContext(s => s.hydrated)
  const tenants = useTenantContext(s => s.tenants)
  const selectedTenants = useTenantContext(s => s.selectedTenants)
  const { linkTo } = useContextHref()

  useEffect(() => {
    hydrateTenantContext()
  }, [])

  const tenant = tenants.find(t => t.tenant === name)
  const normalized = query.trim().toLowerCase()
  const appNamespaces = useMemo(() => {
    if (!tenant) return []
    return normalized
      ? tenant.appNamespaces.filter(ns => ns.toLowerCase().includes(normalized))
      : tenant.appNamespaces
  }, [tenant, normalized])

  const breadcrumbs = [{ label: "Tenants", href: linkTo("/tenants") }, { label: name }]

  if (!hydrated) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <p className="text-sm text-muted-foreground">Loading tenant…</p>
        </main>
      </div>
    )
  }

  if (!tenant) {
    return (
      <div className="min-h-full flex flex-col items-center">
        <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
          <Breadcrumbs items={breadcrumbs} />
          <p className="text-sm text-muted-foreground">Tenant not found</p>
        </main>
      </div>
    )
  }

  const isSelected = selectedTenants.includes(tenant.tenant)

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <header className="flex flex-col gap-4">
          <Breadcrumbs items={breadcrumbs} />

          <div className="flex items-start justify-between gap-8">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <Building2 className="size-6 shrink-0 text-brand-icon" aria-hidden />
                <h1 className="font-heading text-2xl font-semibold tracking-tight text-foreground">
                  {tenant.tenant}
                </h1>
                <span className="rounded-full bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground">
                  {tenant.stackChannel}
                </span>
              </div>
              {tenant.creator && (
                <p className="text-sm text-muted-foreground">Created by {tenant.creator}</p>
              )}
            </div>
            <div className="shrink-0 p-1">
              <RefreshButton />
            </div>
          </div>

          <div className="flex items-start justify-between gap-8 border-b border-gray-200 pb-5">
            <div className="flex flex-wrap gap-x-10 gap-y-4">
              <div className="flex flex-col gap-1.5">
                <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Tenant namespace
                </p>
                <div className="flex">
                  <ValuePill value={tenant.tenantNamespace} copyable />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <p className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Owners
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {tenant.owners.length === 0 ? (
                    <span className="text-sm text-gray-400">&mdash;</span>
                  ) : (
                    tenant.owners.map(owner => (
                      <span
                        key={owner}
                        className="rounded-full bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground"
                      >
                        {owner}
                      </span>
                    ))
                  )}
                </div>
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={isSelected}
              onClick={() => toggleTenant(tenant.tenant)}
              className={cn(
                "w-[104px] shrink-0 justify-center",
                isSelected && "border-brand text-brand hover:bg-background hover:text-brand",
              )}
            >
              {isSelected ? <Check aria-hidden /> : <Building2 aria-hidden />}
              {isSelected ? "Selected" : "Select"}
            </Button>
          </div>
        </header>

        <section className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex items-center justify-between gap-4">
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              App namespaces
            </h2>
            <span className="text-xs tabular-nums text-muted-foreground">
              {tenant.appNamespaces.length}
            </span>
          </div>

          {tenant.appNamespaces.length > FILTER_THRESHOLD && (
            <FilterSearchInput value={query} onChange={setQuery} placeholder="Filter namespaces..." />
          )}

          {tenant.appNamespaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This tenant has no application namespaces.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {appNamespaces.map(ns => (
                <ValuePill key={ns} value={ns} copyable />
              ))}
            </div>
          )}
        </section>

        <KubeconfigPanel key={tenant.tenant} tenant={tenant.tenant} />
      </main>
    </div>
  )
}
