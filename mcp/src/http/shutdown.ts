import { setTimeout, clearTimeout } from 'node:timers'
import type { Server } from 'node:http'

// Stop accepting connections, allow ordinary requests to drain, then terminate
// persistent streams before Kubernetes' 30-second termination deadline.
export async function closeHttpServer(server: Server, graceMs = 20_000): Promise<void> {
  const deadline = setTimeout(() => server.closeAllConnections(), graceMs)

  try {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()))
    })
  } finally {
    clearTimeout(deadline)
  }
}
