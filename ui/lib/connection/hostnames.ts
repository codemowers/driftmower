// A single-label host such as "mcp" relies on cluster admission expanding it;
// unexpanded, nothing outside the cluster resolves it. The desktop reaches
// such an MCP through its own port-forward, which coding agents cannot use.
export function unexpandedHost(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host !== "localhost" && !host.includes(".") && !host.includes(":") && !host.startsWith("[")
  } catch { return false }
}
