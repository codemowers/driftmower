"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Building2, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import PageHeader from "../components/page-header"
import CopyButton from "../components/copy-button"
import OverflowPills from "./components/overflow-pills"
import { FilterSearchInput } from "../components/filter-bar"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { cn } from "@/lib/utils/cn"
import {
  hydrateTenantContext,
  selectTenants,
  toggleTenant,
  useTenantContext,
  type TenantInfo,
} from "@/lib/tenancy/tenant-context"

const UNAVAILABLE_COPY = {
  "not-configured":
    "Tenant management is not configured for this cluster, so there is nothing to list.",
  "stale-session":
    "Your session cannot obtain a platform-manager token. Log out and back in to refresh it.",
  unreachable:
    "platform-manager is configured but did not respond. Check that PLATFORM_MANAGER_URL points at a running service.",
  error: "Tenants could not be loaded.",
}

const ROW_GRID =
  "grid grid-cols-[minmax(0,1.7fr)_minmax(0,1.6fr)_minmax(0,1.7fr)_96px_120px] items-center gap-4"

function matches(tenant: TenantInfo, query: string): boolean {
  const haystack = [
    tenant.tenant,
    tenant.tenantNamespace,
    ...tenant.appNamespaces,
    ...tenant.owners,
    tenant.creator ?? "",
  ]
  return haystack.some(v => v.toLowerCase().includes(query))
}

export default function TenantsPage() {
  const [query, setQuery] = useState("")
  const hydrated = useTenantContext(s => s.hydrated)
  const available = useTenantContext(s => s.available)
  const unavailableReason = useTenantContext(s => s.unavailableReason)
  const admin = useTenantContext(s => s.admin)
  const tenants = useTenantContext(s => s.tenants)
  const selectedTenants = useTenantContext(s => s.selectedTenants)
  const { linkTo } = useContextHref()

  useEffect(() => {
    hydrateTenantContext()
  }, [])

  const normalized = query.trim().toLowerCase()
  const filtered = useMemo(
    () => (normalized ? tenants.filter(t => matches(t, normalized)) : tenants),
    [tenants, normalized],
  )

  const adminPill = admin ? (
    <Tooltip>
      <TooltipTrigger
        tabIndex={0}
        className="cursor-default rounded-full bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        Platform admin
      </TooltipTrigger>
      <TooltipContent side="right">
        <p className="max-w-56">You are a platform admin. All managed tenants are listed.</p>
      </TooltipContent>
    </Tooltip>
  ) : null

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader
          title="Tenants"
          subtitle="Your tenants and their kubeconfig snippets"
          accessory={adminPill}
        />

        {!hydrated && <p className="text-sm text-muted-foreground">Loading tenants…</p>}

        {hydrated && !available && (
          <p className="text-sm text-muted-foreground">
            {UNAVAILABLE_COPY[unavailableReason ?? "error"]}
          </p>
        )}

        {hydrated && available && tenants.length === 0 && (
          <p className="text-sm text-muted-foreground">No tenants available.</p>
        )}

        {hydrated && available && tenants.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="flex items-center gap-5 border-b border-gray-200 px-5 py-3.5">
              <FilterSearchInput
                value={query}
                onChange={setQuery}
                placeholder="Search tenants, namespaces, owners..."
              />
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => selectTenants([...new Set([...selectedTenants, ...filtered.map(t => t.tenant)])])}
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={selectedTenants.length === 0}
                  onClick={() => selectTenants([])}
                >
                  Select none
                </Button>
              </div>
              <div className="flex shrink-0 items-center gap-3 whitespace-nowrap">
                <span className="text-xs text-muted-foreground">
                  {selectedTenants.length} selected &middot; showing {filtered.length} of {tenants.length}
                </span>
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className={cn("text-xs", normalized ? "text-muted-foreground hover:text-brand-label hover:underline" : "text-white")}
                >
                  Reset
                </button>
              </div>
            </div>

            <div className={cn(ROW_GRID, "border-b border-gray-200 px-5 py-3 text-xs font-medium text-muted-foreground")}>
              <span>Tenant</span>
              <span>App namespaces</span>
              <span>Owners</span>
              <span>Channel</span>
              <span />
            </div>

            {filtered.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                No tenants match your search.
              </p>
            ) : (
              filtered.map(tenant => {
                const isSelected = selectedTenants.includes(tenant.tenant)
                return (
                  <Link
                    key={tenant.tenant}
                    href={linkTo(`/tenants/${encodeURIComponent(tenant.tenant)}`)}
                    className={cn(
                      ROW_GRID,
                      "border-b border-gray-200 px-5 py-4 transition-colors last:border-b-0 hover:bg-brand-bg/40",
                      isSelected && "border-l-4 border-l-brand pl-4",
                    )}
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-mono text-sm font-semibold text-foreground">
                        {tenant.tenant}
                      </span>
                      <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                        <span className="truncate">{tenant.tenantNamespace}</span>
                        <CopyButton value={tenant.tenantNamespace} className="relative z-10 shrink-0" />
                      </span>
                    </span>

                    <OverflowPills
                      values={tenant.appNamespaces}
                      label="App namespaces"
                      copyable
                      promote={normalized || undefined}
                    />

                    <OverflowPills values={tenant.owners} label="Owners" />

                    <span className="w-fit rounded-full bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground">
                      {tenant.stackChannel}
                    </span>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-pressed={isSelected}
                      onClick={e => {
                        e.preventDefault()
                        e.stopPropagation()
                        toggleTenant(tenant.tenant)
                      }}
                      className={cn(
                        "relative z-10 w-[104px] justify-center",
                        isSelected && "border-brand text-brand hover:bg-background hover:text-brand",
                      )}
                    >
                      {isSelected ? <Check aria-hidden /> : <Building2 aria-hidden />}
                      {isSelected ? "Selected" : "Select"}
                    </Button>
                  </Link>
                )
              })
            )}
          </div>
        )}
      </main>
    </div>
  )
}
