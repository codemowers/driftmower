"use client"
import { unexpandedHost } from "@/lib/connection/hostnames"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useEffect, useState } from "react"
import PageHeader from "@/app/components/page-header"
import CopyButton from "@/app/components/copy-button"
import Card from "@/app/components/layout/card"
import CommandSnippet from "@/app/components/command-snippet"
import { useKubectl } from "@/lib/hooks/use-kubectl"
import { cn } from "@/lib/utils/cn"
import MarkdownText from "@/app/components/markdown-text"
import PrefetchLink from "@/app/components/prefetch-link"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { callTool, fetchMcp, selectedEndpoint } from "@/browser/connection"
import { mcpQuickstart, SERVER_NAME, type McpClientId, type McpScope, type McpServerTarget } from "@/lib/features/provisioning/mcp-quickstarts"

type Registered = { name: string; namespace?: string; url: string; description?: string }
type Server = McpServerTarget & { description?: string; registered?: string; current?: boolean }

const AGENTS: { id: McpClientId; label: string }[] = [
  { id: "codex", label: "Codex" },
  { id: "claude-code", label: "Claude Code" },
  { id: "opencode", label: "opencode" },
]

const REGISTRATION_EXAMPLE = `apiVersion: codemowers.ai/v1alpha1
kind: ClusterMCPServer
metadata:
  name: example-mcp
  annotations:
    kubernetes.io/description: >-
      Describe the tools and information this server provides.
spec:
  url: https://mcp.example.com/mcp
`

function serverKey(server: Server) { return `${server.registered ?? ""}/${server.name}` }

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
  const { linkTo } = useContextHref()
  const kubectl = useKubectl()
  const [agent, setAgent] = useState<McpClientId>("claude-code")
  const [scope, setScope] = useState<McpScope>("user")
  const [servers, setServers] = useState<Server[]>([])
  const [error, setError] = useState("")
  const [selected, setSelected] = useState("")
  const selectedServer = servers.find(server => serverKey(server) === selected) ?? servers[0]
  const recipe = selectedServer ? mcpQuickstart(agent, selectedServer, scope) : null

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const current: Server = { name: SERVER_NAME, url: await selectedEndpoint(), current: true, description: "This cluster's driftmower: workloads, drift, resources and logs, as you may see them." }
      const found: Server[] = [current]
      try {
        const res = await fetchMcp("/api/client-config", { cache: "no-store" })
        const body = res.ok ? await res.json() as { resource?: string; clientId?: string } : {}
        if (body.resource) current.url = body.resource
        current.clientId = body.clientId
      } catch (e) { setError(String(e)) }
      try {
        const r = await callTool<{ servers: Registered[] }>("list_mcp_servers")
        for (const s of r.servers) {
          const registered = s.namespace ? `MCPServer ${s.namespace}/${s.name}` : `ClusterMCPServer ${s.name}`
          if (s.name === SERVER_NAME && !s.namespace) {
            current.registered = registered
            if (s.description) current.description = s.description
          } else found.push({ name: s.name, url: s.url, description: s.description, registered })
        }
      } catch { /* Older servers lack the tool; driftmower alone is offered. */ }
      if (!cancelled) setServers(found)
    })()
    return () => { cancelled = true }
  }, [])

  return (
    <>
      <Page>
        <PageHeader icon={ICONS.codingAgent} title="Coding agent" subtitle="Connect a coding agent to the MCP servers available to you. Each signs you in itself; nothing here hands out a credential." />
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
        <div className="grid min-w-0 items-start gap-6 lg:grid-cols-2">
          <Card title="MCP servers" flush>
            {servers.length === 0 && <p className="p-5 text-sm text-muted-foreground">Loading MCP servers…</p>}
            <ul className="divide-y divide-gray-200">
              {servers.map(server => <li key={serverKey(server)}>
                <button type="button" onClick={() => setSelected(serverKey(server))}
                  aria-pressed={server === selectedServer}
                  className={cn("flex w-full min-w-0 flex-col gap-2 px-5 py-4 text-left transition-colors hover:bg-muted/60", server === selectedServer && "bg-muted")}>
                  <span className={cn("font-mono text-sm font-medium", server === selectedServer ? "text-brand-text" : "text-foreground")}>{server.name}</span>
                  <span className="break-all font-mono text-xs text-muted-foreground">{server.url}</span>
                  <span className="font-mono text-xs text-muted-foreground">{server.registered ?? "this dashboard's MCP"}</span>
                </button>
              </li>)}
            </ul>
          </Card>
          <Card title={selectedServer ? `Add ${selectedServer.name}` : "Add to coding agent"}>
            {selectedServer && recipe ? <>
              {selectedServer.current && <PrefetchLink href={linkTo("/coding-agent/mcp-servers/driftmower")} className="text-sm text-brand-text hover:underline">View available tools</PrefetchLink>}
              {selectedServer.description && <MarkdownText text={selectedServer.description} className="text-sm text-muted-foreground" />}
              {unexpandedHost(selectedServer.url) ? <p className="text-sm text-status-minor-label">
                {selectedServer.url} is a short hostname this cluster does not expand into a public address, so a coding agent cannot reach it. {selectedServer.current && "The dashboard connects through the desktop's own port-forward, which agents cannot use, and MCP's sign-in audience is tied to this address. "}Publishing MCP under a resolvable hostname requires the cluster to expand short Ingress hosts, as the codemowers platform does.
              </p> : <>
              {internalOnly(selectedServer.url) && <p className="text-xs text-status-minor-label">Reachable only from inside the cluster, such as by agents running there.</p>}
              {recipe.caption && <p className="text-sm text-muted-foreground">{recipe.caption}</p>}
              {recipe.blocks.map(block => (
                <div key={block} className="relative min-w-0">
                  <span className="absolute right-3 top-2 z-10"><CopyButton value={block} /></span>
                  <pre className="overflow-x-auto bg-muted px-3 py-2 pr-10 font-mono text-xs text-foreground">{block}</pre>
                </div>
              ))}
              </>}
            </> : <p className="text-sm text-muted-foreground">Commands appear when the MCP servers have loaded.</p>}
          </Card>
        </div>
        <Card title="Register another MCP server">
          <p className="text-sm text-muted-foreground">Save this as <code>mcp-server.yaml</code>, replace the name, description and URL, then apply it to this cluster. Use an endpoint your coding agent can reach.</p>
          <CommandSnippet title="ClusterMCPServer example" command={REGISTRATION_EXAMPLE} collapsible={false} fullHeight />
          <CommandSnippet title="Apply registration" command={`${kubectl("apply")} -f mcp-server.yaml`} collapsible={false} />
          <p className="text-sm text-muted-foreground">The cluster must have the ClusterMCPServer CRD installed, and you need permission to create the resource. Reload this page after applying; registered servers appear when you have permission to list them. Registration advertises the endpoint; the server still controls sign-in and access.</p>
          <p className="text-sm text-muted-foreground">For namespace-scoped registration, use <code>kind: MCPServer</code> and add <code>metadata.namespace</code>. Set <code>spec.audience</code> only when the server requires a specific audience for projected ServiceAccount tokens; laptop sign-in uses the server’s own authentication.</p>
        </Card>
      </Page>
    </>
  )
}
