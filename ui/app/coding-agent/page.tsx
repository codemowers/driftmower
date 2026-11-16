"use client"

import { useEffect, useState } from "react"
import PageHeader from "@/app/components/page-header"
import CopyButton from "@/app/components/copy-button"
import MarkdownText from "@/app/components/markdown-text"
import { callTool, fetchMcp } from "@/browser/connection"
import { mcpQuickstart, SERVER_NAME, type McpClientId, type McpScope, type McpServerTarget } from "@/lib/features/provisioning/mcp-quickstarts"

type Registered = { name: string; namespace?: string; url: string; description?: string }
type Server = McpServerTarget & { description?: string; registered?: string }

const AGENTS: { id: McpClientId; label: string }[] = [
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
  { id: "opencode", label: "opencode" },
]

// A URL a laptop cannot reach: plain HTTP or a cluster-internal Service.
function internalOnly(url: string) {
  try {
    const u = new URL(url)
    return u.protocol !== "https:" || u.hostname.endsWith(".svc") || u.hostname.endsWith(".svc.cluster.local")
  } catch { return true }
}

// Every MCP server available to you, this one first, with the command or
// configuration that adds it to the chosen agent at the chosen scope. Only
// sign-in flows are offered: no credential is handed out here.
export default function CodingAgentPage() {
  const [agent, setAgent] = useState<McpClientId>("claude-code")
  const [scope, setScope] = useState<McpScope>("user")
  const [servers, setServers] = useState<Server[]>([])
  const [error, setError] = useState("")

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const found: Server[] = []
      try {
        const res = await fetchMcp("/api/client-config", { cache: "no-store" })
        const body = res.ok ? await res.json() as { resource?: string; clientId?: string } : {}
        if (body.resource) found.push({ name: SERVER_NAME, url: body.resource, clientId: body.clientId, description: "This cluster's driftmower: workloads, drift, resources and logs, as you may see them." })
      } catch (e) { setError(String(e)) }
      try {
        const r = await callTool<{ servers: Registered[] }>("list_mcp_servers")
        for (const s of r.servers) found.push({ name: s.name, url: s.url, description: s.description, registered: s.namespace ? `MCPServer ${s.namespace}/${s.name}` : `ClusterMCPServer ${s.name}` })
      } catch { /* Older servers lack the tool; driftmower alone is offered. */ }
      if (!cancelled) setServers(found)
    })()
    return () => { cancelled = true }
  }, [])

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-6 px-7 py-12">
        <PageHeader title="Coding agent" subtitle="Connect a coding agent to the MCP servers available to you. Each signs you in itself; nothing here hands out a credential." />
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="flex items-center gap-2">
            Agent
            <select value={agent} onChange={e => setAgent(e.target.value as McpClientId)} className="rounded-md border border-gray-200 bg-white px-2 py-1">
              {AGENTS.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2">
            Scope
            <select value={scope} onChange={e => setScope(e.target.value as McpScope)} className="rounded-md border border-gray-200 bg-white px-2 py-1">
              <option value="user">User: every project</option>
              <option value="project">Project: shared with the repository</option>
            </select>
          </label>
        </div>
        {error && <p className="text-sm text-muted-foreground">{error}</p>}
        {servers.map(server => {
          const recipe = mcpQuickstart(agent, server, scope)
          return (
            <section key={`${server.registered ?? ""}/${server.name}`} className="flex flex-col gap-2 rounded-xl border border-gray-200 bg-white px-5 py-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-mono text-sm font-medium text-foreground">{server.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{server.registered ?? "this dashboard's MCP"}</span>
              </div>
              <span className="font-mono text-xs text-muted-foreground">{server.url}</span>
              {server.description && <MarkdownText text={server.description} className="text-sm text-muted-foreground" />}
              {internalOnly(server.url) && <p className="text-xs text-status-minor-label">Reachable only from inside the cluster, such as by agents running there.</p>}
              {recipe.caption && <p className="text-sm text-muted-foreground">{recipe.caption}</p>}
              {recipe.blocks.map(block => (
                <div key={block} className="relative">
                  <span className="absolute right-3 top-2 z-10"><CopyButton value={block} /></span>
                  <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 pr-10 font-mono text-xs text-foreground">{block}</pre>
                </div>
              ))}
            </section>
          )
        })}
      </main>
    </div>
  )
}
