"use client"

import { useEffect, useState } from "react"
import { KeyRound } from "lucide-react"

import CopyButton from "@/app/components/copy-button"
import { readApiError } from "@/lib/utils/read-api-error"
import { mcpQuickstarts, type Quickstart } from "@/lib/features/provisioning/mcp-quickstarts"

// Connect a coding agent to the MCP gateway.
//
// The gateway answers the same questions this page does, plus the drift
// analysis — so an agent can ask "what will bite me in this namespace" without
// a person relaying the page. Only the OAuth flow is offered: the client signs
// in itself and refreshes its own token, so no credential is handed out here.

type ConfigState =
  | { status: "loading" }
  | { status: "unconfigured"; reason: string }
  | { status: "ready"; mcpUrl: string; clientId: string }

export default function McpPanel() {
  const [config, setConfig] = useState<ConfigState>({ status: "loading" })

  useEffect(() => {
    let cancelled = false

    fetch("/api/mcp/config", { cache: "no-store" })
      .then(async res => {
        if (cancelled) return
        if (!res.ok) {
          const reason = await readApiError(res)
          if (!cancelled) setConfig({ status: "unconfigured", reason })
          return
        }
        const body = await res.json()
        if (!body.enabled) {
          setConfig({
            status: "unconfigured",
            reason:
              "MCP is not enabled on this deployment. Until MCP_ENABLED is set, login does not request the MCP resource, so no token for the gateway can be issued.",
          })
          return
        }
        if (!body.mcpUrl) {
          setConfig({
            status: "unconfigured",
            reason: "No public URL is configured for the MCP gateway (MCP_PUBLIC_URL).",
          })
          return
        }
        if (!body.clientId) {
          setConfig({
            status: "unconfigured",
            reason:
              "No OIDC client is configured for the MCP gateway (MCP_OIDC_CLIENT_ID), so a coding agent has nothing to sign in with.",
          })
          return
        }

        setConfig({ status: "ready", mcpUrl: body.mcpUrl, clientId: body.clientId })
      })
      .catch(e => {
        if (!cancelled) setConfig({ status: "unconfigured", reason: String(e) })
      })

    return () => {
      cancelled = true
    }
  }, [])

  if (config.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  if (config.status === "unconfigured") {
    return <p className="text-sm text-muted-foreground">{config.reason}</p>
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-card px-5 py-4">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 shrink-0 text-brand-icon" />
          <code className="font-mono text-sm text-foreground">{config.mcpUrl}</code>
          <span className="relative z-10">
            <CopyButton value={config.mcpUrl} />
          </span>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Add the server with your client&apos;s command below. It opens a browser to sign you in and
          refreshes its own token from then on.
        </p>
      </div>

      {mcpQuickstarts(config).map(quickstart => (
        <QuickstartBlock key={quickstart.id} quickstart={quickstart} />
      ))}
    </div>
  )
}

function QuickstartBlock({ quickstart }: { quickstart: Quickstart }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium text-foreground">{quickstart.heading}</p>
      {quickstart.caption && <p className="-mt-1 text-sm text-muted-foreground">{quickstart.caption}</p>}
      {quickstart.blocks.map(block => (
        <div key={block} className="relative">
          <span className="absolute right-3 top-2 z-10">
            <CopyButton value={block} />
          </span>
          <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 pr-10 font-mono text-xs text-foreground">
            {block}
          </pre>
        </div>
      ))}
    </div>
  )
}
