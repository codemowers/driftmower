"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { Check, Package } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import PageHeader from "../components/page-header"
import CopyButton from "../components/copy-button"
import OverflowPills from "./components/overflow-pills"
import { FilterSearchInput } from "../components/filter-bar"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { cn } from "@/lib/utils/cn"
import {
  hydrateSandboxContext,
  selectSandboxes,
  toggleSandbox,
  useSandboxContext,
  type SandboxInfo,
} from "@/lib/tenancy/sandbox-context"

const UNAVAILABLE_COPY = {
  "not-configured":
    "Sandbox management is not configured for this cluster, so there is nothing to list.",
  "stale-session":
    "Your session cannot obtain a platform-manager token. Log out and back in to refresh it.",
  unreachable:
    "platform-manager is configured but did not respond. Check that PLATFORM_MANAGER_URL points at a running service.",
  error: "Sandboxes could not be loaded.",
}

const ROW_GRID =
  "grid grid-cols-[minmax(0,1.7fr)_minmax(0,1.6fr)_minmax(0,1.7fr)_96px_120px] items-center gap-4"

function matches(sandbox: SandboxInfo, query: string): boolean {
  const haystack = [
    sandbox.sandbox,
    sandbox.name,
    sandbox.namespace,
    ...sandbox.owners,
    sandbox.creator ?? "",
  ]
  return haystack.some(v => v.toLowerCase().includes(query))
}

export default function SandboxesPage() {
  const [query, setQuery] = useState("")
  const hydrated = useSandboxContext(s => s.hydrated)
  const available = useSandboxContext(s => s.available)
  const unavailableReason = useSandboxContext(s => s.unavailableReason)
  const admin = useSandboxContext(s => s.admin)
  const sandboxes = useSandboxContext(s => s.sandboxes)
  const selectedSandboxes = useSandboxContext(s => s.selectedSandboxes)
  const { linkTo } = useContextHref()

  useEffect(() => {
    hydrateSandboxContext()
  }, [])

  const normalized = query.trim().toLowerCase()
  const filtered = useMemo(
    () => (normalized ? sandboxes.filter(s => matches(s, normalized)) : sandboxes),
    [sandboxes, normalized],
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
        <p className="max-w-56">You are a platform admin. All managed sandboxes are listed.</p>
      </TooltipContent>
    </Tooltip>
  ) : null

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader
          title="Sandboxes"
          subtitle="Your sandboxes and their kubeconfig snippets"
          accessory={adminPill}
        />

        {!hydrated && <p className="text-sm text-muted-foreground">Loading sandboxes…</p>}

        {hydrated && !available && (
          <p className="text-sm text-muted-foreground">
            {UNAVAILABLE_COPY[unavailableReason ?? "error"]}
          </p>
        )}

        {hydrated && available && sandboxes.length === 0 && (
          <p className="text-sm text-muted-foreground">No sandboxes available.</p>
        )}

        {hydrated && available && sandboxes.length > 0 && (
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="flex items-center gap-5 border-b border-gray-200 px-5 py-3.5">
              <FilterSearchInput
                value={query}
                onChange={setQuery}
                placeholder="Search sandboxes, namespaces, owners..."
              />
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => selectSandboxes([...new Set([...selectedSandboxes, ...filtered.map(s => s.sandbox)])])}
                >
                  Select all
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={selectedSandboxes.length === 0}
                  onClick={() => selectSandboxes([])}
                >
                  Select none
                </Button>
              </div>
              <div className="flex shrink-0 items-center gap-3 whitespace-nowrap">
                <span className="text-xs text-muted-foreground">
                  {selectedSandboxes.length} selected &middot; showing {filtered.length} of {sandboxes.length}
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
              <span>Sandbox</span>
              <span>App namespaces</span>
              <span>Owners</span>
              <span>Channel</span>
              <span />
            </div>

            {filtered.length === 0 ? (
              <p className="px-5 py-10 text-center text-sm text-muted-foreground">
                No sandboxes match your search.
              </p>
            ) : (
              filtered.map(sandbox => {
                const isSelected = selectedSandboxes.includes(sandbox.sandbox)
                return (
                  <Link
                    key={sandbox.sandbox}
                    href={linkTo(`/sandboxes/${encodeURIComponent(sandbox.sandbox)}`, { drop: ["focus"] })}
                    className={cn(
                      ROW_GRID,
                      "border-b border-gray-200 px-5 py-4 transition-colors last:border-b-0 hover:bg-brand-bg/40",
                      isSelected && "border-l-4 border-l-brand pl-4",
                    )}
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-mono text-sm font-semibold text-foreground">
                        {sandbox.sandbox}
                      </span>
                      <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                        <span className="truncate">{sandbox.namespace}</span>
                        <CopyButton value={sandbox.namespace} className="relative z-10 shrink-0" />
                      </span>
                    </span>

                    <span className="truncate text-sm text-muted-foreground">{sandbox.name}</span>

                    <OverflowPills values={sandbox.owners} label="Owners" />

                    <span className="w-fit rounded-full bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground">
                      {sandbox.stackChannel}
                    </span>

                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-pressed={isSelected}
                      onClick={e => {
                        e.preventDefault()
                        e.stopPropagation()
                        toggleSandbox(sandbox.sandbox)
                      }}
                      className={cn(
                        "relative z-10 w-[104px] justify-center",
                        isSelected && "border-brand text-brand hover:bg-background hover:text-brand",
                      )}
                    >
                      {isSelected ? <Check aria-hidden /> : <Package aria-hidden />}
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
