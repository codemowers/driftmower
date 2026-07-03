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
  PanelLeft,
  Server,
  ServerOff,
  ShieldCheck,
  ShipWheel,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils/cn"
import type { SessionClaims } from "@/lib/auth/session"
import DriftmowerLogo from "./driftmower-logo"
import NavUser from "./nav-user"

type NavItem = {
  name: string
  href: string
  icon: LucideIcon
}

const navItems: NavItem[] = [
  { name: "Executive Summary", href: "/executive-summary", icon: BarChart3 },
  { name: "OIDC Applications", href: "/oidc-applications", icon: ShieldCheck },
  { name: "Topmost Owners", href: "/topmost-owners", icon: Boxes },
  { name: "Helm Releases", href: "/helm-releases", icon: ShipWheel },
  { name: "Cluster", href: "/cluster", icon: Cpu },
]

function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") {
    return pathname === "/" || pathname === "/executive-summary"
  }
  return pathname === href || pathname.startsWith(`${href}/`)
}

export default function NavBar({ claims }: { claims: SessionClaims }) {
  const [isExpanded, setIsExpanded] = useState(true)
  const { isConnected, clusterName, reportId } = useClusterState()
  const pathname = usePathname()

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
            {navItems.map((item) => {
              const Icon = item.icon
              const active = isNavActive(pathname, item.href)

              const href = reportId ? `${item.href}?report=${reportId}` : item.href
              const link = (
                <Link
                  href={href}
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

              return (
                <li key={item.href} className="w-full">
                  {isExpanded ? (
                    link
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
      <footer
        className={cn(
          "flex w-full flex-col justify-center py-3 px-5",
          isExpanded
            ? "border-t border-gray-200 gap-0.5"
            : "items-center py-4",
        )}
      >
        <div
          className={cn("flex items-center gap-2", !isExpanded && "justify-center")}
        >
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
              <span className="font-mono text-sm font-medium tracking-tighter text-gray-800">
                {isConnected ? "Connected" : "Disconnected"}
              </span>
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
                  {isConnected ? `Cluster: ${clusterName}` : null}
                </p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        {isExpanded && (
          <p className="text-xs font-mono text-gray-400 pl-4">
            Cluster: {clusterName ?? "none"}
          </p>
        )}
      </footer>

      <NavUser claims={claims} isExpanded={isExpanded} />
    </div>
  )
}
