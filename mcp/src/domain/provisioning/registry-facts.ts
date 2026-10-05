// PURE. A container registry a namespace can push to, found in the namespace
// itself rather than assumed from any platform convention: a Deployment that
// runs Zot, a Service that selects its pods, and an Ingress that publishes that
// Service under a hostname. Nothing about who installed it is presumed, so the
// same answer holds for a per-tenant Zot and for one an operator deployed by hand.

export type RawRegistryDeployment = {
  metadata?: { name?: string }
  spec?: {
    template?: {
      metadata?: { labels?: Record<string, string> }
      spec?: { containers?: { image?: string }[] }
    }
  }
}

export type RawService = {
  metadata?: { name?: string }
  spec?: { selector?: Record<string, string> }
}

export type RawIngress = {
  metadata?: { name?: string }
  spec?: {
    tls?: { hosts?: string[] }[]
    rules?: {
      host?: string
      http?: { paths?: { backend?: { service?: { name?: string } } }[] }
    }[]
  }
}

export type DiscoveredRegistry = {
  kind: 'zot'
  host: string
  // Whether the Ingress terminates TLS for this host. Without it the registry
  // is plain HTTP, which Docker and Skaffold refuse unless told it is insecure.
  tls: boolean
  deployment: string
  service: string
  ingress: string
}

export type RegistryFact = DiscoveredRegistry & {
  // A ready-to-save skaffold.env: the namespace-qualified kube context, this
  // registry as the default repo, and the namespace.
  skaffoldEnv: string
}

// Zot publishes zot, zot-minimal and per-arch builds (zot-linux-amd64); the
// repository's last path segment is what identifies it, wherever it is mirrored.
export function isZotImage(image: string): boolean {
  const withoutDigest = image.split('@')[0]
  const lastSegment = withoutDigest.split('/').pop() ?? ''
  const repository = lastSegment.split(':')[0]

  return /^zot(?:-[a-z0-9-]+)?$/.test(repository)
}

export function findRegistries(
  deployments: RawRegistryDeployment[],
  services: RawService[],
  ingresses: RawIngress[]
): DiscoveredRegistry[] {
  const found: DiscoveredRegistry[] = []

  for (const deployment of deployments) {
    const containers = deployment.spec?.template?.spec?.containers ?? []

    if (!containers.some(container => container.image && isZotImage(container.image))) continue

    const podLabels = deployment.spec?.template?.metadata?.labels ?? {}
    // A Service with no selector routes to nothing on its own, and one whose
    // selector is a subset of the pod labels is the one that reaches this Zot.
    const selecting = services.filter(service => {
      const selector = Object.entries(service.spec?.selector ?? {})

      return selector.length > 0 && selector.every(([key, value]) => podLabels[key] === value)
    })

    for (const service of selecting) {
      const serviceName = service.metadata?.name

      if (!serviceName) continue

      for (const ingress of ingresses) {
        for (const rule of ingress.spec?.rules ?? []) {
          const routes = (rule.http?.paths ?? []).some(path => path.backend?.service?.name === serviceName)

          if (!rule.host || !routes || found.some(entry => entry.host === rule.host)) continue

          found.push({
            kind: 'zot',
            host: rule.host,
            tls: (ingress.spec?.tls ?? []).some(entry => entry.hosts?.includes(rule.host!) ?? false),
            deployment: deployment.metadata?.name ?? '(unnamed)',
            service: serviceName,
            ingress: ingress.metadata?.name ?? '(unnamed)'
          })
        }
      }
    }
  }

  return found.sort((a, b) => a.host.localeCompare(b.host))
}

// Skaffold reads skaffold.env from the directory it runs in. The context is the
// namespace-qualified one the connection instructions ask for, so a build is
// pushed here and deployed to this namespace and never to whatever context
// happens to be current.
export function skaffoldEnvFor(input: { context: string; registryHost: string; namespace: string }): string {
  return [
    `SKAFFOLD_KUBE_CONTEXT=${input.context}`,
    `SKAFFOLD_DEFAULT_REPO=${input.registryHost}`,
    `SKAFFOLD_NAMESPACE=${input.namespace}`,
    // Keep the deployment running after `skaffold dev` exits instead of deleting it.
    'SKAFFOLD_CLEANUP=false'
  ].join('\n')
}

export function kubeContextFor(clusterId: string | null, namespace: string): string {
  return `${clusterId ?? '<cluster>'}/${namespace}`
}
