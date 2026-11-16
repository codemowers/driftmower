import type { KubeconfigConnection } from "./contexts"

export function contextTitle(endpoint: string): string {
  if (!URL.canParse(endpoint)) return "Select a cluster"
  const url = new URL(endpoint)
  if (!["https:", "http:"].includes(url.protocol) || !url.hostname) return "Select a cluster"
  return url.hostname.replace(/^(?:mcp|dashboard)\.driftmower\./i, "")
}

export function connectionTitle(connection: KubeconfigConnection | undefined, endpoint: string): string {
  if (connection && (connection.portForward || !connection.url)) return connection.name
  return contextTitle(connection?.url ?? endpoint)
}
