import process from 'node:process'

// Kubernetes service links inject <SERVICE>_PORT=tcp://<ip>:<port> into every
// pod in a namespace for every Service there. For a Service named
// driftmower-mcp that variable is DRIFTMOWER_MCP_PORT, which is also this
// server's own port setting, and the config loader then refuses to start.
//
// Some platforms disable service links for every pod by admission policy and
// ask manifests not to set enableServiceLinks themselves; others do not. So
// the server tolerates the injected value instead of depending on either: a
// service-link URL is never a port number, and dropping it lets the
// configured default apply.
const SETTINGS_SHADOWED_BY_SERVICE_LINKS = ['DRIFTMOWER_MCP_PORT']
const SERVICE_LINK_VALUE = /^(tcp|udp|sctp):\/\//

export function dropServiceLinkValues(env: Record<string, string | undefined>): string[] {
  const dropped: string[] = []

  for (const name of SETTINGS_SHADOWED_BY_SERVICE_LINKS) {
    if (SERVICE_LINK_VALUE.test(env[name] ?? '')) {
      delete env[name]
      dropped.push(name)
    }
  }

  return dropped
}

// Runs at import, before the config library reads the environment; index.ts
// imports this module first for exactly that reason.
dropServiceLinkValues(process.env)
