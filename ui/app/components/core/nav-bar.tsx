"use client"

import { useState, useEffect, startTransition } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { LucideIcon } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import {
  Boxes,
  BarChart3,
  Cpu,
  Layers,
  PanelLeft,
  Server,
  ServerOff,
  LayoutGrid,
  Package,
  PackagePlus,
  ShipWheel,
  ChevronsUpDown,
  Pin,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils/cn"
import type { SessionClaims } from "@/lib/auth/session"
import { useSandboxContext } from "@/lib/tenancy/sandbox-context"
import { noteNavigation } from "@/lib/browser/in-app-history"
import { setActivePageSection, usePageSectionsStore } from "@/lib/hooks/use-page-sections"
import DriftmowerLogo from "./driftmower-logo"
import NavUser from "./nav-user"
import SandboxPicker from "./sandbox-picker"
import type { ClusterEndpoint } from "@/browser/connection"

type NavItem = {
  name: string
  href: string
  icon: LucideIcon
  // Shows the whole cluster and cannot be narrowed to a sandbox, so it is
  // hidden from sandbox users -- the route 404s for them either way.
  clusterWide?: true
}

const navItems: NavItem[] = [
  { name: "Executive Summary", href: "/executive-summary", icon: BarChart3 },
  { name: "Topmost Owners", href: "/topmost-owners", icon: Boxes },
  { name: "Helm Releases", href: "/helm-releases", icon: ShipWheel },
  { name: "Container Images", href: "/container-images", icon: Layers },
  { name: "Cluster", href: "/cluster", icon: Cpu, clusterWide: true },
  { name: "Applications", href: "/applications", icon: LayoutGrid },
  { name: "Sandboxes", href: "/sandboxes", icon: Package },
  { name: "Provisioning", href: "/provisioning", icon: PackagePlus },
]

function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export default function NavBar({
  claims,
  seesClusterWideViews,
  clusterEndpoints,
  activeEndpoint,
  pinnedEndpoints = [],
  fixedEndpoint = false,
  onSelectEndpoint,
  onAddEndpoint,
  streamUpdates,
  onStreamUpdatesChange,
}: {
  claims: SessionClaims
  seesClusterWideViews: boolean
  clusterEndpoints?: ClusterEndpoint[]
  activeEndpoint?: string
  pinnedEndpoints?: string[]
  fixedEndpoint?: boolean
  onSelectEndpoint?: (url: string) => void
  onAddEndpoint?: (endpoint: ClusterEndpoint) => void
  streamUpdates?: boolean
  onStreamUpdatesChange?: (enabled: boolean) => void
}) {
  const [isExpanded, setIsExpanded] = useState(true)
  const { isConnected, connectionError, clusterName } = useClusterState()
  const selectedSandboxes = useSandboxContext(s => s.selectedSandboxes)
  const pathname = usePathname()
  const pageSections = usePageSectionsStore()
  const [newEndpoint, setNewEndpoint] = useState("")
  const [endpointError, setEndpointError] = useState("")

  // Resolved on the server, so a hidden item never flashes in on first paint.
  const visibleItems = navItems.filter(item => seesClusterWideViews || !item.clusterWide)

  const carriedParams = new URLSearchParams()
  if (selectedSandboxes.length > 0) carriedParams.set("sandbox", selectedSandboxes.join(","))
  const carriedQuery = carriedParams.toString()

  useEffect(() => {
    noteNavigation(pathname)
  }, [pathname])

  useEffect(() => {
    if (localStorage.getItem("nav-expanded") === "false") {
      startTransition(() => setIsExpanded(false))
    }
  }, [])

  return (
    <div
      className={cn(
        "flex h-full min-h-0 w-full flex-col bg-gray-10 transition-[width] duration-200",
        isExpanded ? "w-[300px]" : "w-[50px]",
      )}
    >
      {/* Header */}
      <header
        className={cn(
          "flex w-full items-center border-gray-200 py-4",
          isExpanded
            ? "justify-between border-b pl-5 pr-3"
            : "justify-center px-0",
        )}
      >
        {isExpanded && <DriftmowerLogo />}
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Toggle sidebar"
          onClick={() => setIsExpanded(v => {
            const next = !v
            localStorage.setItem("nav-expanded", String(next))
            return next
          })}
        >
          <PanelLeft className="size-4 text-gray-500" aria-hidden />
        </Button>
      </header>


      {/* Nav items */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <SandboxPicker isExpanded={isExpanded} />

        {isExpanded && (
          <h2 className="mt-5 w-full px-5 font-mono text-sm font-medium tracking-wide text-gray-400">
            Navigate
          </h2>
        )}

        <nav
          aria-label="Main navigation"
          className={cn("mt-2 flex w-full flex-col", isExpanded ? "px-3" : "items-center px-0")}
        >
          <ul className="flex w-full flex-col gap-1">
            {visibleItems.map((item) => {
              const Icon = item.icon
              const active = isNavActive(pathname, item.href)

              const href = carriedQuery ? `${item.href}?${carriedQuery}` : item.href
              const link = (
                <Link
                  href={href}
                  prefetch
                  title={isExpanded ? item.name : undefined}
                  aria-label={item.name}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-md py-3 text-sm transition-colors",
                    isExpanded
                      ? cn(
                        "px-3",
                        active
                          ? "border-l-4 border-brand bg-muted font-semibold text-brand"
                          : "border-l-4 border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )
                      : cn(
                        "justify-center px-2 py-3 mx-0.5",
                        active
                          ? "bg-muted text-brand"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      ),
                  )}
                >
                  <Icon
                    className={cn(
                      "size-5 shrink-0",
                      active
                        ? "text-brand"
                        : "text-muted-foreground",
                    )}
                    aria-hidden
                  />
                  {isExpanded && <span>{item.name}</span>}
                </Link>
              )

              // The open page's own sections, nested under its entry.
              const sections =
                isExpanded && active && pageSections.href === item.href ? pageSections.sections : []

              return (
                <li key={item.href} className="w-full">
                  {isExpanded ? (
                    <>
                      {link}
                      {sections.length > 0 && (
                        <ul
                          aria-label={`${item.name} sections`}
                          className="mb-1 ml-9 mt-1 flex flex-col border-l border-border"
                        >
                          {sections.map(section => {
                            const current = section.id === pageSections.active
                            return (
                              <li key={section.id}>
                                <a
                                  href={`#${section.id}`}
                                  aria-current={current ? "location" : undefined}
                                  onClick={() => setActivePageSection(section.id)}
                                  className={cn(
                                    "-ml-px block border-l py-1.5 pl-3 pr-2 text-sm transition-colors",
                                    current
                                      ? "border-brand font-medium text-brand"
                                      : "border-transparent text-muted-foreground hover:text-foreground",
                                  )}
                                >
                                  {section.title}
                                </a>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        {link}
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <p className="font-medium">
                          {item.name}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </li>
              )
            })}
          </ul>
        </nav>
      </div>



      {/* Footer */}
      <footer className={cn("w-full border-t border-gray-200 p-3", !isExpanded && "px-1")}>
        <details className="group relative">
          <summary className={cn("flex cursor-pointer list-none items-center gap-2 rounded-md p-2 hover:bg-muted/60", !isExpanded && "justify-center")}>
          {isExpanded ? (
            <>
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full ring-2 ring-offset-1",
                  isConnected
                    ? "bg-status-ok ring-status-ok"
                    : "bg-status-major ring-status-major",
                )}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-xs text-muted-foreground">{isConnected ? "Connected context" : "Disconnected"}</span>
                <span className="block truncate text-sm font-medium text-gray-800">{clusterName ?? "Select a cluster"}</span>
              </span>
              {onSelectEndpoint && !fixedEndpoint && <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
            </>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className="relative inline-flex cursor-default"
                  role="img"
                  aria-label={
                    isConnected ? "Connected" : "Disconnected"
                  }
                >
                  {isConnected ? (
                    <Server
                      className="size-5 text-muted-foreground"
                      aria-hidden
                    />
                  ) : (
                    <ServerOff
                      className="size-5 text-muted-foreground"
                      aria-hidden
                    />
                  )}
                  <span
                    className={cn(
                      "absolute -right-0.5 -top-0.5 size-1.5 rounded-full ring-1 ring-white",
                      isConnected
                        ? "bg-status-ok"
                        : "bg-status-major",
                    )}
                    aria-hidden
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p className="font-medium">
                  {isConnected ? "Connected" : "Disconnected"}
                </p>
                <p className="text-muted-foreground">
                  {isConnected ? `Cluster: ${clusterName}` : connectionError}
                </p>
              </TooltipContent>
            </Tooltip>
          )}
          </summary>
          {isExpanded && onSelectEndpoint && !fixedEndpoint && <div className="absolute bottom-full left-0 z-30 mb-2 max-h-80 w-full overflow-auto rounded-md border bg-background p-2 shadow-lg">
            <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Switch context</p>
            {(clusterEndpoints ?? []).map(endpoint => <button key={endpoint.url} type="button" onClick={() => onSelectEndpoint(endpoint.url)} className={cn("flex w-full items-center gap-2 truncate rounded px-2 py-2 text-left text-sm hover:bg-muted", endpoint.url === activeEndpoint && "font-semibold text-brand")} title={endpoint.url}>{pinnedEndpoints.includes(endpoint.url) && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Discovered context" />}<span className="truncate">{endpoint.name}</span></button>)}
            {(clusterEndpoints ?? []).length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No contexts added yet.</p>}
            {onAddEndpoint && <form className="mt-2 border-t pt-2" onSubmit={event => {event.preventDefault();try { const url = new URL(newEndpoint); onAddEndpoint({name:url.hostname,url:newEndpoint}); setNewEndpoint("");setEndpointError("")} catch(error) {setEndpointError(error instanceof Error ? error.message : "Invalid endpoint")}}}>
              <label className="block px-2 text-xs text-muted-foreground" htmlFor="mcp-context-url">Add MCP address</label>
              <div className="mt-1 flex gap-1"><input id="mcp-context-url" className="min-w-0 flex-1 rounded border px-2 py-1 text-xs" placeholder="https://cluster.example/mcp" value={newEndpoint} onChange={event=>setNewEndpoint(event.target.value)} /><button type="submit" className="rounded border px-2 text-xs">Add</button></div>
              {endpointError && <p role="alert" className="px-2 pt-1 text-xs text-status-major-text">{endpointError}</p>}
            </form>}
          </div>}
        </details>
        {isExpanded && !isConnected && connectionError && <p className="mt-1 line-clamp-2 break-words px-2 text-xs text-status-major-text" title={connectionError}>{connectionError}</p>}
        {isExpanded && onStreamUpdatesChange && <details className="mt-2 px-2 text-xs">
          <summary className="cursor-pointer text-muted-foreground">Settings</summary>
          <label className="mt-2 flex items-start gap-2"><input type="checkbox" checked={Boolean(streamUpdates)} onChange={event=>onStreamUpdatesChange(event.target.checked)} /><span><span className="font-medium text-foreground">Stream updates</span><span className="mt-1 block text-muted-foreground">Refresh from MCP notifications, with polling fallback.</span></span></label>
        </details>}
      </footer>

      <NavUser claims={claims} isExpanded={isExpanded} />
    </div>
  )
}
