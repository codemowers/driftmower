import { z } from 'zod'

export const clusterIdentitySchema = z.object({
  id: z.string().nullable(),
  apiUrl: z.string().nullable(),
  mcpServerName: z.string(),
  authentication: z.literal('passmower-oidc').optional(),
  oidcIssuerUrl: z.string().optional()
})

export type ClusterIdentity = z.infer<typeof clusterIdentitySchema>

export function clusterIdentity(
  id: string | null,
  apiUrl: string | null,
  publicUrl: string
): ClusterIdentity {
  // The full domain keeps providers with identical region names distinct.
  const suffix = (id ?? new URL(publicUrl).host).toLowerCase().replace(/[^a-z0-9_-]+/g, '-')

  return { id, apiUrl, mcpServerName: `driftmower-${suffix}` }
}

export function clusterInstructions(cluster: ClusterIdentity): string {
  return [
    `This MCP connection identifies cluster ${JSON.stringify(cluster.id)}; its external Kubernetes API URL is ${JSON.stringify(cluster.apiUrl)}.`,
    'Use get_cluster_identity to inspect this identity. A server registration name or kubeconfig context name is only a hint, not proof of cluster identity.',
    'Before using kubectl, compare this API URL with the server URLs in the local kubeconfig. Do not print credentials or use kubectl config view --raw.',
    `For every namespace the user wants to work with, use a separate kubeconfig context named ${cluster.id ?? '<cluster>'}/<namespace>, with its context.namespace explicitly set to that namespace. Use the cluster name ${JSON.stringify(cluster.id)} for the kubeconfig cluster entry. Never use a namespace-less context, including for Skaffold; set Skaffold deploy.kubeContext to this exact namespace-qualified context.`,
    'Before creating a context, verify the API URL and reuse the intended existing credentials. Create it with kubectl config set-context <cluster>/<namespace> --cluster=<cluster> --user=<verified-user> --namespace=<namespace>. Do not overwrite an existing context that points elsewhere.',
    'Use an explicit --context on every kubectl command that accesses the cluster. If identity is missing, URLs do not match, or the credential choice is ambiguous, ask the user to identify the context or credentials. Multiple namespaces on the same verified cluster are expected. Never assume the current context or switch it implicitly.',
    ...(cluster.authentication === 'passmower-oidc'
      ? [
          `The default/kubelogin Ingress exposes this Kubernetes API via Passmower OIDC. Set up kubectl oidc-login (kubectl krew install oidc-login) with exec apiVersion client.authentication.k8s.io/v1beta1, command kubectl, and arguments oidc-login get-token --oidc-issuer-url=${cluster.oidcIssuerUrl ?? '<confirmed OIDC issuer URL>'} --oidc-client-id=default.kubelogin --oidc-extra-scope=profile,email,groups --listen-address=127.0.0.1:27890. Preserve existing kubeconfig entries and keep credentials out of output.`
        ]
      : []),
    'Read this connection’s get_engineering_advisory before planning changes. Its cluster overrides replace bundled guidance at the same path; do not combine conflicting advice from other clusters.',
    'Live Kubernetes discovery and observability describe this cluster. Drift analysis comes from configured backend snapshots; check their scope rather than assuming that every backend workload belongs to this cluster.'
  ].join(' ')
}
