"use client"
import { connectionForEndpoint } from "@/lib/kubernetes/contexts"
import { connectionTitle } from "@/lib/kubernetes/labels"

import { useState, useEffect, startTransition } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { LucideIcon } from "lucide-react"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useKubeconfigState } from "@/lib/kubernetes/context-state"
import { PanelLeft, Server, ServerOff, ChevronsUpDown, Pin, LoaderCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils/cn"
import type { SessionClaims } from "@/lib/auth/types"
import { useSandboxContext } from "@/lib/tenancy/sandbox-context"
import { useResourceNavigationStore } from "@/lib/hooks/use-resource-navigation"
import { setActivePageSection, usePageSectionsStore } from "@/lib/hooks/use-page-sections"
import DriftmowerLogo from "./driftmower-logo"
import NavUser from "./nav-user"
import SandboxPicker from "./sandbox-picker"
import DownloadProgress from "@/app/components/download-progress"
import { ICONS } from "@/app/components/layout/icons"
import { callTool, contextTitle, toolNames, useConnectionProgress, type ClusterEndpoint } from "@/browser/connection"

// Checks each gated item once per connected endpoint: the MCP server must
// offer its tool and the cluster authorizer must allow its operation. An
// unanswered or failed check hides the item.
function useAllowedItems(items: NavItem[], enabled: boolean, endpoint: string | undefined): Set<string> {
  const [allowed, setAllowed] = useState<{ endpoint?: string; hrefs: Set<string> }>({ hrefs: new Set() })
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const gated = items.filter(item => item.requires || item.tool)
    const tools = toolNames().catch(() => new Set<string>())
    void Promise.all(gated.map(async item => {
      if (item.tool && !(await tools).has(item.tool)) return null
      if (!item.requires) return item.href
      return callTool<{ verdict: string }>("check_access", { group: "", ...item.requires })
        .then(r => (r.verdict === "yes" ? item.href : null))
        .catch(() => null)
    })).then(hrefs => {
      if (!cancelled) setAllowed({ endpoint, hrefs: new Set(hrefs.filter((h): h is string => h !== null)) })
    })
    return () => { cancelled = true }
  }, [items, enabled, endpoint])
  return allowed.endpoint === endpoint ? allowed.hrefs : new Set()
}

type NavItem = {
  // The heading the item is listed under.
  group?: string
  name: string
  href: string
  icon: LucideIcon
  // Shows the whole cluster and cannot be narrowed to a sandbox, so it is
  // hidden from sandbox users -- the route 404s for them either way.
  clusterWide?: true
  // Shown only when the cluster authorizer allows this caller the operation.
  requires?: { verb: string; resource: string; group?: string }
  // Shown only when the connected MCP server offers this tool.
  tool?: string
}

// Grouped under headings; the first and last groups have none.
const navItems: NavItem[] = [
  { name: "Executive Summary", href: "/executive-summary", icon: ICONS.summary },
  { group: "Workloads", name: "Top-level", href: "/topmost-owners", icon: ICONS.workloads },
  { group: "Workloads", name: "Namespaces", href: "/namespaces", icon: ICONS.namespaces },
  { group: "Workloads", name: "Applications", href: "/applications", icon: ICONS.applications },
  { group: "Workloads", name: "Helm Releases", href: "/helm-releases", icon: ICONS.helmReleases },
  { group: "Workloads", name: "Container Images", href: "/container-images", icon: ICONS.containerImages },
  { group: "Workloads", name: "Source Repositories", href: "/source-repositories", icon: ICONS.sources, tool: "get_source_findings" },
  { group: "Workloads", name: "Operators", href: "/operators", icon: ICONS.operators },
  { group: "Workloads", name: "Sandboxes", href: "/sandboxes", icon: ICONS.sandboxes },
  { group: "Cluster", name: "Nodes", href: "/cluster", icon: ICONS.nodes, requires: { verb: "list", resource: "nodes" } },
  { group: "Cluster", name: "Alerts", href: "/alerts", icon: ICONS.alerts, tool: "list_alerts" },
  { group: "Cluster", name: "Volumes", href: "/volumes", icon: ICONS.volumes, requires: { verb: "list", resource: "persistentvolumes" } },
  { group: "Cluster", name: "Storage classes", href: "/storage-classes", icon: ICONS.storageClasses },
  { group: "Cluster", name: "Priority classes", href: "/priority-classes", icon: ICONS.priorityClasses, tool: "list_priority_classes" },
  { group: "Security", name: "Advisories", href: "/advisories", icon: ICONS.advisories, tool: "get_workload_findings" },
  { group: "Security", name: "Vulnerabilities", href: "/vulnerabilities", icon: ICONS.vulnerabilities, tool: "get_image_scans" },
  { group: "Security", name: "Admission policies", href: "/admission-policies", icon: ICONS.admissionPolicies },
  { group: "Security", name: "Trust", href: "/trust", icon: ICONS.trust },
  { group: "Security", name: "Users", href: "/users", icon: ICONS.users, tool: "list_oidc_users" },
  { group: "Security", name: "Groups", href: "/groups", icon: ICONS.groups, tool: "list_oidc_users" },
  { group: "Security", name: "Service accounts", href: "/service-accounts", icon: ICONS.serviceAccounts, tool: "list_service_accounts" },
  { group: "Settings", name: "General", href: "/settings", icon: ICONS.settings },
  { group: "Settings", name: "Coding agent", href: "/coding-agent", icon: ICONS.codingAgent },
  { group: "Settings", name: "Container registry", href: "/registry", icon: ICONS.registry },
]

function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

export default function NavBar({
  claims,
  seesClusterWideViews,
  navigationEnabled = true,
  clusterEndpoints,
  activeEndpoint,
  pinnedEndpoints = [],
  fixedEndpoint = false,
  onSelectEndpoint,
  onAddEndpoint,
}: {
  claims?: SessionClaims | null
  navigationEnabled?: boolean
  seesClusterWideViews: boolean
  clusterEndpoints?: ClusterEndpoint[]
  activeEndpoint?: string
  pinnedEndpoints?: string[]
  fixedEndpoint?: boolean
  onSelectEndpoint?: (url: string, contextKey?: string) => void
  onAddEndpoint?: (endpoint: ClusterEndpoint) => void
}) {
  const connectingTo=useConnectionProgress(state=>state.target)
  const connectingLabel=useConnectionProgress(state=>state.label)
  const selectedContextKey = useKubeconfigState(state => state.selectedKey)
  const selectedEndpointURL = useKubeconfigState(state => state.endpoint)
  const displayEndpoint=connectingTo||activeEndpoint||selectedEndpointURL
  const connections=useKubeconfigState(state=>state.connections)
  const displayConnection=connections.find(c=>c.key===connectingTo)??connectionForEndpoint(connections,displayEndpoint,selectedContextKey)
  const displayContext=connectingLabel||connectionTitle(displayConnection,displayEndpoint)
  const [isExpanded, setIsExpanded] = useState(true)
  const { isConnected, connectionError } = useClusterState()
  const selectedSandboxes = useSandboxContext(s => s.selectedSandboxes)
  const pathname = usePathname()
  const pageSections = usePageSectionsStore()
  const resourceNavigation = useResourceNavigationStore(s => s.navigation)
  const [newEndpoint, setNewEndpoint] = useState("")
  const [endpointError, setEndpointError] = useState("")

  // Resolved on the server, so a hidden item never flashes in on first paint.
  const allowedItems = useAllowedItems(navItems, navigationEnabled, activeEndpoint)
  const visibleItems = navItems.filter(item =>
    (!navigationEnabled || seesClusterWideViews || !item.clusterWide) && (!(item.requires || item.tool) || allowedItems.has(item.href)))

  const carriedParams = new URLSearchParams()
  if (selectedSandboxes.length > 0) carriedParams.set("sandbox", selectedSandboxes.join(","))
  const carriedQuery = carriedParams.toString()

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
        {navigationEnabled && <SandboxPicker isExpanded={isExpanded} />}


        <nav
          aria-label="Main navigation"
          className={cn("mt-4 flex w-full flex-col", isExpanded ? "px-3" : "items-center px-0")}
        >
          <ul className="flex w-full flex-col gap-1">
            {visibleItems.map((item, i) => {
              const heading = item.group && item.group !== visibleItems[i - 1]?.group ? item.group : null
              const Icon = item.icon
              const disabled = !navigationEnabled && item.href !== "/settings"
              const active = !disabled && (navigationEnabled ? isNavActive(pathname, item.href) : item.href === "/settings")

              const href = carriedQuery ? `${item.href}?${carriedQuery}` : item.href
              const link = (
                <Link
                  href={href}
                  prefetch={!disabled}
                  aria-disabled={disabled || undefined}
                  tabIndex={disabled ? -1 : undefined}
                  onClick={event => { if (disabled) event.preventDefault() }}
                  title={isExpanded ? item.name : undefined}
                  aria-label={item.name}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3 rounded-md py-3 text-sm transition-colors",
                    disabled && "pointer-events-none cursor-not-allowed opacity-40",
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
                  {heading && (isExpanded
                    ? <h2 className="mb-1 mt-4 px-3 font-mono text-xs font-medium uppercase tracking-wide text-gray-400">{heading}</h2>
                    : <hr className="mx-2 my-2 border-gray-200" aria-hidden />)}
                  {isExpanded ? (
                    <>
                      {link}
                      {active && resourceNavigation?.parent === item.href && (
                        // The selected resource's subpages as plain sub-items of the
                        // still-highlighted section entry: no resource level, no tree.
                        <ul aria-label="Subpages" className="mb-1 mt-0.5 flex flex-col">
                          {resourceNavigation.items.map(entry => {
                            const current = pathname === entry.href.split("?")[0]
                            return <li key={entry.href}>
                              {entry.disabled
                                ? <span className="block py-1.5 pl-12 pr-3 text-sm text-muted-foreground/50">{entry.label}</span>
                                : <Link href={entry.href} aria-current={current ? "page" : undefined}
                                    className={cn("block py-1.5 pl-12 pr-3 text-sm transition-colors", current ? "font-semibold text-brand" : "text-muted-foreground hover:text-foreground")}>
                                    {entry.label}
                                  </Link>}
                            </li>
                          })}
                        </ul>
                      )}
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
              {connectingTo?<LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" aria-label="Connecting"/>:<span
                className={cn(
                  "size-2 shrink-0 rounded-full ring-2 ring-offset-1",
                  isConnected
                    ? "bg-status-ok ring-status-ok"
                    : "bg-status-major ring-status-major",
                )}
                aria-hidden
              />}
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-xs text-muted-foreground">{connectingTo ? "Connecting…" : isConnected ? "Connected context" : "Disconnected"}{connectingTo && <> <DownloadProgress /></>}</span>
                <span className="block truncate text-sm font-medium text-gray-800">{displayContext}</span>
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
                    connectingTo ? "Connecting" : isConnected ? "Connected" : "Disconnected"
                  }
                >
                  {connectingTo ? <LoaderCircle className="size-5 animate-spin text-muted-foreground" aria-label="Connecting"/> : isConnected ? (
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
                  {connectingTo ? "Connecting" : isConnected ? "Connected" : "Disconnected"}
                </p>
                <p className="text-muted-foreground">
                  {isConnected ? `Cluster: ${displayContext}` : connectionError}
                </p>
              </TooltipContent>
            </Tooltip>
          )}
          </summary>
          {isExpanded && onSelectEndpoint && !fixedEndpoint && <div className="absolute bottom-full left-0 z-30 mb-2 max-h-80 w-full overflow-auto rounded-md border bg-background p-2 shadow-lg">
            <p className="px-2 py-1 text-xs font-medium text-muted-foreground">Switch context</p>
            {(clusterEndpoints ?? []).map(endpoint => <button key={endpoint.contextKey ?? endpoint.url} type="button" disabled={Boolean(connectingTo)} onClick={() => onSelectEndpoint(endpoint.url, endpoint.contextKey)} className={cn("flex w-full items-center gap-2 truncate rounded px-2 py-2 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40", endpoint.url === activeEndpoint && (!endpoint.contextKey || endpoint.contextKey === selectedContextKey) && "font-semibold text-brand")} title={endpoint.url}>{pinnedEndpoints.includes(endpoint.url) && <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Discovered context" />}<span className="truncate">{endpoint.contextKey ? `${endpoint.name} · ${endpoint.authMethod}` : contextTitle(endpoint.url)}</span></button>)}
            {(clusterEndpoints ?? []).length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground">No contexts added yet.</p>}
            {onAddEndpoint && <form className="mt-2 border-t pt-2" onSubmit={event => {event.preventDefault();try { const url = new URL(newEndpoint); onAddEndpoint({name:url.hostname,url:newEndpoint}); setNewEndpoint("");setEndpointError("")} catch(error) {setEndpointError(error instanceof Error ? error.message : "Invalid endpoint")}}}>
              <label className="block px-2 text-xs text-muted-foreground" htmlFor="mcp-context-url">Add MCP address</label>
              <div className="mt-1 flex gap-1"><input id="mcp-context-url" className="min-w-0 flex-1 rounded border px-2 py-1 text-xs" placeholder="https://cluster.example/mcp" value={newEndpoint} onChange={event=>setNewEndpoint(event.target.value)} /><button type="submit" className="rounded border px-2 text-xs">Add</button></div>
              {endpointError && <p role="alert" className="px-2 pt-1 text-xs text-status-major-text">{endpointError}</p>}
            </form>}
          </div>}
        </details>
        {isExpanded && !isConnected && connectionError && <p className="mt-1 line-clamp-2 break-words px-2 text-xs text-status-major-text" title={connectionError}>{connectionError}</p>}

      </footer>

      {claims && <NavUser claims={claims} isExpanded={isExpanded} />}
    </div>
  )
}
