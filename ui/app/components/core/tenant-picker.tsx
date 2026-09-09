"use client"

import { Building2, ChevronsUpDown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { FilterToggle } from "@/app/components/filter-bar"
import { cn } from "@/lib/utils/cn"
import {
  ALL_TENANTS_LABEL,
  selectTenants,
  toggleTenant,
  useTenantContext,
  useTenantScope,
} from "@/lib/tenancy/tenant-context"

export default function TenantPicker({ isExpanded }: { isExpanded: boolean }) {
  const hydrated = useTenantContext(s => s.hydrated)
  const available = useTenantContext(s => s.available)
  const admin = useTenantContext(s => s.admin)
  const tenants = useTenantContext(s => s.tenants)
  const selectedTenants = useTenantContext(s => s.selectedTenants)
  const { namespaces } = useTenantScope()

  if (!hydrated || !available) return null

  const unscopedLabel = admin ? "Whole cluster" : ALL_TENANTS_LABEL
  const label =
    selectedTenants.length === 0
      ? unscopedLabel
      : selectedTenants.length === 1
        ? selectedTenants[0]
        : `${selectedTenants.length} tenants`

  const showUnscopedRow = admin || tenants.length > 1
  // A ?tenant= deep link can name tenants the user cannot see; still list them
  // so the current selection is visible and re-selectable.
  const unknownSelection = selectedTenants.filter(t => !tenants.some(k => k.tenant === t))
  const isSingleTenantUser = !admin && tenants.length === 1 && unknownSelection.length === 0

  const trigger = (
    <PopoverTrigger
      aria-label={`Tenant context: ${label}`}
      className={cn(
        "flex cursor-pointer items-center rounded-md text-sm text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted aria-expanded:text-foreground",
        isExpanded ? "w-full gap-3 px-3 py-3" : "justify-center px-2 py-3 mx-0.5",
      )}
    >
      <span className="relative inline-flex shrink-0">
        <Building2 className="size-5 text-muted-foreground" aria-hidden />
        {!isExpanded && selectedTenants.length > 0 && (
          <span className="absolute -right-1 -top-1 size-1.5 rounded-full bg-brand" aria-hidden />
        )}
      </span>
      {isExpanded && (
        <>
          <span className="min-w-0 flex-1 truncate text-left font-mono text-sm font-medium tracking-tighter">
            {label}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-gray-400" aria-hidden />
        </>
      )}
    </PopoverTrigger>
  )

  return (
    <div className="flex w-full flex-col">
      {isExpanded && (
        <h2 className="mt-5 w-full px-5 font-mono text-sm font-medium tracking-wide text-gray-400">
          Tenant
        </h2>
      )}
      <div className={cn("mt-2 flex w-full flex-col", isExpanded ? "px-3" : "px-0")}>
        <Popover>
          {isExpanded ? (
            trigger
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>{trigger}</TooltipTrigger>
              <TooltipContent side="right">
                <p className="font-medium">Tenant: {label}</p>
              </TooltipContent>
            </Tooltip>
          )}

          <PopoverContent
            side={isExpanded ? "bottom" : "right"}
            align="start"
            className="w-72 gap-0.5 p-2"
          >
            <div className="flex items-center justify-between px-3 pb-1 pt-1">
              <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Tenant context
              </span>
              {!isSingleTenantUser && selectedTenants.length > 0 && (
                <button
                  type="button"
                  onClick={() => selectTenants([])}
                  className="text-xs text-muted-foreground hover:text-brand-label hover:underline"
                >
                  Clear
                </button>
              )}
            </div>

            {showUnscopedRow && (
              <>
                <FilterToggle
                  checked={selectedTenants.length === 0}
                  onToggle={() => selectTenants([])}
                  label={unscopedLabel}
                />
                <div className="my-1 h-px bg-gray-200" />
              </>
            )}

            <div className="max-h-64 overflow-y-auto">
              {tenants.map(t => (
                <FilterToggle
                  key={t.tenant}
                  checked={selectedTenants.includes(t.tenant)}
                  onToggle={() => toggleTenant(t.tenant)}
                  label={<span className="font-mono">{t.tenant}</span>}
                  count={1 + t.appNamespaces.length}
                />
              ))}
              {unknownSelection.map(t => (
                <FilterToggle
                  key={t}
                  checked
                  onToggle={() => toggleTenant(t)}
                  label={<span className="font-mono">{t}</span>}
                />
              ))}
            </div>

            {namespaces !== null && (
              <>
                <div className="my-1 h-px bg-gray-200" />
                <p className="px-3 pb-1 text-xs text-muted-foreground">
                  {selectedTenants.length === 0
                    ? `All ${tenants.length} tenants`
                    : selectedTenants.length === 1
                      ? "1 tenant selected"
                      : `${selectedTenants.length} tenants selected`}
                  , {namespaces.length} namespaces in scope
                </p>
              </>
            )}
          </PopoverContent>
        </Popover>
      </div>
      {!isExpanded && <div className="mx-auto mt-2 h-px w-8 bg-gray-200" aria-hidden />}
    </div>
  )
}
