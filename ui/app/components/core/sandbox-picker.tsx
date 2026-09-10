"use client"

import { Building2, ChevronsUpDown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { FilterToggle } from "@/app/components/filter-bar"
import { cn } from "@/lib/utils/cn"
import { selectSandboxes, toggleSandbox, useSandboxContext } from "@/lib/tenancy/sandbox-context"

export default function SandboxPicker({ isExpanded }: { isExpanded: boolean }) {
  const hydrated = useSandboxContext(s => s.hydrated)
  const available = useSandboxContext(s => s.available)
  const admin = useSandboxContext(s => s.admin)
  const sandboxes = useSandboxContext(s => s.sandboxes)
  const selectedSandboxes = useSandboxContext(s => s.selectedSandboxes)

  if (!hydrated || !available) return null

  const label =
    selectedSandboxes.length === 0
      ? "Whole cluster"
      : selectedSandboxes.length === 1
        ? selectedSandboxes[0]
        : `${selectedSandboxes.length} sandboxes`

  const showWholeCluster = admin || sandboxes.length === 0
  // A ?sandbox= deep link can name sandboxes the user cannot see; still list
  // them so the current selection is visible and re-selectable.
  const unknownSelection = selectedSandboxes.filter(id => !sandboxes.some(s => s.sandbox === id))
  const isSingleSandboxUser =
    !showWholeCluster && sandboxes.length === 1 && unknownSelection.length === 0
  // A sandbox is one namespace, so the scope is one entry per selection.
  const namespacesInScope = new Set(
    selectedSandboxes.flatMap(id => {
      const sandbox = sandboxes.find(s => s.sandbox === id)
      return sandbox ? [sandbox.namespace] : []
    }),
  )

  const trigger = (
    <PopoverTrigger
      aria-label={`Sandbox context: ${label}`}
      className={cn(
        "flex cursor-pointer items-center rounded-md text-sm text-muted-foreground outline-none transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted aria-expanded:text-foreground",
        isExpanded ? "w-full gap-3 px-3 py-3" : "justify-center px-2 py-3 mx-0.5",
      )}
    >
      <span className="relative inline-flex shrink-0">
        <Building2 className="size-5 text-muted-foreground" aria-hidden />
        {!isExpanded && selectedSandboxes.length > 0 && (
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
              {!isSingleSandboxUser && selectedSandboxes.length > 0 && (
                <button
                  type="button"
                  onClick={() => selectSandboxes([])}
                  className="text-xs text-muted-foreground hover:text-brand-label hover:underline"
                >
                  Clear
                </button>
              )}
            </div>

            {showWholeCluster && (
              <>
                <FilterToggle
                  checked={selectedSandboxes.length === 0}
                  onToggle={() => selectSandboxes([])}
                  label="Whole cluster"
                />
                <div className="my-1 h-px bg-gray-200" />
              </>
            )}

            <div className="max-h-64 overflow-y-auto">
              {sandboxes.map(s => (
                <FilterToggle
                  key={s.sandbox}
                  checked={selectedSandboxes.includes(s.sandbox)}
                  onToggle={() => toggleSandbox(s.sandbox)}
                  label={<span className="font-mono">{s.sandbox}</span>}
                  count={1}
                />
              ))}
              {unknownSelection.map(t => (
                <FilterToggle
                  key={t}
                  checked
                  onToggle={() => toggleSandbox(t)}
                  label={<span className="font-mono">{t}</span>}
                />
              ))}
            </div>

            {selectedSandboxes.length > 0 && (
              <>
                <div className="my-1 h-px bg-gray-200" />
                <p className="px-3 pb-1 text-xs text-muted-foreground">
                  {selectedSandboxes.length === 1
                    ? "1 sandbox selected"
                    : `${selectedSandboxes.length} sandboxes selected`}
                  , {namespacesInScope.size} namespaces in scope
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
