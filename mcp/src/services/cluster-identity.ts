import { z } from 'zod'
import { clusterIdentity, type ClusterIdentity } from '../domain/cluster-identity.js'

const ingressSchema = z.object({
  spec: z.object({ rules: z.array(z.object({ host: z.string().optional() })).optional() })
})

// Only a concrete, unambiguous ingress rule identifies the public API.
export async function discoverClusterIdentity(
  fallback: ClusterIdentity,
  readIngress: () => Promise<unknown>,
  warn: (message: string) => void,
  oidcIssuerUrl?: string
): Promise<ClusterIdentity> {
  try {
    const ingress = ingressSchema.parse(await readIngress())
    const hosts = [...new Set(ingress.spec.rules?.map(rule => rule.host).filter(Boolean))]
    const host = hosts.length === 1 ? hosts[0] : undefined

    if (
      !host ||
      host.length > 253 ||
      !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
    ) {
      warn('default/kubelogin has no unambiguous DNS hostname; retaining configured cluster identity')

      return fallback
    }

    const hostname = host.toLowerCase()
    const apiUrl = `https://${hostname}`

    return {
      ...clusterIdentity(hostname.replace(/^kube\./, ''), apiUrl, apiUrl),
      authentication: 'passmower-oidc',
      ...(oidcIssuerUrl ? { oidcIssuerUrl } : {})
    }
  } catch (error) {
    if (!(error instanceof Error && error.message === 'Kubernetes API returned HTTP 404')) {
      warn('Unable to discover default/kubelogin; retaining configured cluster identity')
    }

    return fallback
  }
}
