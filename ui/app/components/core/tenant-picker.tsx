"use client"

import { ChevronsUpDown, Layers } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils/cn"
import { selectTenant, useTenantContext } from "@/lib/tenancy/tenant-context"

// Radix radio items need a non-empty value; this sentinel stands in for the
// null ("Whole cluster") selection.
const WHOLE_CLUSTER = "__whole_cluster__"

export default function TenantPicker({ isExpanded }: { isExpanded: boolean }) {
  const hydrated = useTenantContext(s => s.hydrated)
  const available = useTenantContext(s => s.available)
  const admin = useTenantContext(s => s.admin)
  const tenants = useTenantContext(s => s.tenants)
  const selectedTenant = useTenantContext(s => s.selectedTenant)

  if (!hydrated || !available) return null

  const label = selectedTenant ?? "Whole cluster"
  const showWholeCluster = admin || tenants.length === 0
  // A ?tenant= deep link can name a tenant the user cannot see; still list it
  // so the current selection is visible and re-selectable.
  const unknownSelection =
    selectedTenant !== null && !tenants.some(t => t.tenant === selectedTenant)
      ? selectedTenant
      : null

  const trigger = (
    <DropdownMenuTrigger
      aria-label={`Tenant context: ${label}`}
      className={cn(
        "flex cursor-pointer items-center rounded-md text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground",
        isExpanded ? "w-full gap-3 px-3 py-2.5" : "justify-center px-2 py-3 mx-0.5",
      )}
    >
      <Layers className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      {isExpanded && (
        <>
          <span className="min-w-0 flex-1 truncate text-left font-mono text-sm font-medium tracking-tighter">
            {label}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-gray-400" aria-hidden />
        </>
      )}
    </DropdownMenuTrigger>
  )

  return (
    <div className="flex w-full flex-col">
      {isExpanded && (
        <h2 className="mt-5 w-full px-5 font-mono text-sm font-medium tracking-wide text-gray-400">
          Tenant
        </h2>
      )}
      <div className={cn("mt-2 flex w-full flex-col", isExpanded ? "px-3" : "items-center px-0")}>
        <DropdownMenu>
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

          <DropdownMenuContent
            side={isExpanded ? "bottom" : "right"}
            align="start"
            className="w-64"
          >
            <DropdownMenuLabel>Tenant context</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={selectedTenant ?? WHOLE_CLUSTER}
              onValueChange={value => selectTenant(value === WHOLE_CLUSTER ? null : value)}
            >
              {showWholeCluster && (
                <DropdownMenuRadioItem value={WHOLE_CLUSTER}>Whole cluster</DropdownMenuRadioItem>
              )}
              {tenants.map(t => (
                <DropdownMenuRadioItem key={t.tenant} value={t.tenant}>
                  <span className="min-w-0 truncate font-mono">{t.tenant}</span>
                </DropdownMenuRadioItem>
              ))}
              {unknownSelection && (
                <DropdownMenuRadioItem value={unknownSelection}>
                  <span className="min-w-0 truncate font-mono">{unknownSelection}</span>
                </DropdownMenuRadioItem>
              )}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
