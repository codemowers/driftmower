"use client"
import { ICONS } from "@/app/components/layout/icons"
import Page from "@/app/components/layout/page"

import { useCallback, useState } from "react"
import { Download, RefreshCw } from "lucide-react"
import { listMcpTools, selectedEndpoint } from "@/browser/connection"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useKubeconfigState } from "@/lib/kubernetes/context-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { useQuery } from "@/lib/hooks/use-query"
import { toolParameters, toolSignature } from "@/lib/features/mcp/tools"
import ResourceHeader from "@/app/components/resource-header"
import CopyButton from "@/app/components/copy-button"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"

export default function McpServerPage() {
  const { linkTo } = useContextHref()
  const cluster = useClusterState(s => s.clusterName)
  const endpoint = useKubeconfigState(s => s.endpoint)
  const identity = useKubeconfigState(s => s.selectedKey)
  const [filter, setFilter] = useState("")
  const load = useCallback(async () => ({ tools: await listMcpTools(), endpoint: await selectedEndpoint() }), [])
  const result = useQuery({ key: JSON.stringify([cluster, endpoint, identity, "mcp-tools"]), load })
  const tools = result.data?.tools ?? []
  const query = filter.trim().toLowerCase()
  const visible = tools.filter(tool => [tool.name, tool.title, tool.description, ...toolParameters(tool).map(p => p.name)].join(" ").toLowerCase().includes(query)).sort((a, b) => a.name.localeCompare(b.name))

  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ tools }, null, 2) + "\n"], { type: "application/json" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = "driftmower-mcp-tools.json"
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <Page>
    <ResourceHeader icon={ICONS.mcpServer} iconAriaLabel="MCP server" title="driftmower" copyValue={result.data?.endpoint}
      breadcrumbs={[{ label: "Coding agent", href: linkTo("/coding-agent") }, { label: "MCP server driftmower" }]}
      subtitle={<span className="break-all font-mono text-xs">{result.data?.endpoint ?? "Connected MCP server"}</span>} />
    <div className="flex flex-wrap items-center gap-3">
      <input aria-label="Filter MCP tools" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Filter tools or parameters…" className="w-full max-w-md rounded-lg border bg-white px-3 py-2 text-sm" />
      {result.data && <span className="text-xs text-muted-foreground">{visible.length} of {tools.length} tools</span>}
      <button onClick={result.retry} disabled={result.loading} className="ml-auto inline-flex items-center gap-1.5 text-sm text-brand-text disabled:opacity-50"><RefreshCw className="size-4" />Refresh tools</button>
      <button onClick={download} disabled={!result.data} className="inline-flex items-center gap-1.5 text-sm text-brand-text disabled:opacity-50"><Download className="size-4" />Download JSON</button>
    </div>
    {result.loading && <LoadingLine loading="MCP tools" />}
    {result.error && <LoadError message={`Could not load MCP tools: ${result.error}`} onRetry={result.retry} />}
    {result.data && !visible.length && <p className="text-sm text-muted-foreground">{query ? "No tools match your filter." : "This server advertises no tools."}</p>}
    {visible.map(tool => <section key={tool.name} className="min-w-0 rounded-xl border border-gray-200 bg-white" aria-label={`Tool ${tool.name}`}>
      <header className="flex items-start gap-3 border-b border-gray-100 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="break-all font-mono text-sm font-semibold">{tool.name}</h2>
          {tool.title && tool.title !== tool.name && <p className="mt-1 text-sm text-muted-foreground">{tool.title}</p>}
        </div>
        <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{tool.annotations?.readOnlyHint === true ? "Read-only" : tool.annotations?.readOnlyHint === false ? "Mutating" : "Access unspecified"}</span>
        <CopyButton value={toolSignature(tool)} />
      </header>
      <div className="flex flex-col gap-4 px-5 py-4">
        <code className="whitespace-pre-wrap break-words font-mono text-xs text-brand-text">{toolSignature(tool)}</code>
        {tool.description && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{tool.description}</p>}
        {toolParameters(tool).length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <thead className="border-b text-xs text-muted-foreground"><tr><th className="py-2 pr-4">Parameter</th><th className="pr-4">Type</th><th>Description</th></tr></thead>
          <tbody>{toolParameters(tool).map(parameter => <tr key={parameter.name} className="border-b border-gray-100 last:border-0 align-top">
            <td className="py-2 pr-4 font-mono text-xs">{parameter.name}<span className="mt-1 block font-sans text-muted-foreground">{parameter.required ? "Required" : "Optional"}</span></td>
            <td className="max-w-md break-words py-2 pr-4 font-mono text-xs">{parameter.type}</td>
            <td className="py-2 text-xs text-muted-foreground">{parameter.description}{parameter.defaultValue !== undefined && <p>Default: <code>{parameter.defaultValue}</code></p>}</td>
          </tr>)}</tbody>
        </table></div>}
        {(["inputSchema", "outputSchema"] as const).map(key => tool[key] && <details key={key}>
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">{key === "inputSchema" ? "Input schema" : "Output schema"}</summary>
          <pre className="mt-2 max-h-[32rem] overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(tool[key], null, 2)}</pre>
        </details>)}
      </div>
    </section>)}
  </Page>
}
