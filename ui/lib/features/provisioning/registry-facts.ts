// PURE. Which registry to push to, and whether this namespace can pull from it.
//
// One correction worth stating in code, because it is a tempting wrong turn:
// image pulls are performed by the kubelet on the node, not by the pod. The
// sandbox egress NetworkPolicy therefore does NOT affect them — and a user
// cannot "fix" a pull failure with a network policy they are not permitted to
// create anyway. The real constraints are the registry convention and whether
// an imagePullSecret exists in the namespace.

export type RegistryFact = {
  host: string
  // How many running containers on this cluster come from it, which is how we
  // tell the house registry from an incidental one.
  imageCount: number
  // True for the registry that serves most of this cluster's own workloads.
  isHouseRegistry: boolean
  requiresPullSecret: boolean
}

// Docker Hub images carry no registry host at all, and a bare "library/nginx"
// is not a hostname. Normalising keeps the counts honest.
const DOCKER_HUB = "docker.io"

// platform-manager's sandbox-stack chart gives every enabled Zot instance a
// policy-defined host. Unlike the old cluster-image heuristic below, this is a
// push target the sandbox owner is actually authorised to use.
export function sandboxRegistryHost(sandbox: string, ingressDomain: string): string {
  return `${sandbox}-registry.${ingressDomain}`
}

export function registryHostOf(image: string): string {
  const withoutDigest = image.split("@")[0]
  const segments = withoutDigest.split("/")
  // A registry host only exists when something follows it. "redis:7-alpine" is
  // one segment, so its colon is a tag rather than a port; reading that as a
  // host invents a registry that does not exist.
  if (segments.length < 2) return DOCKER_HUB
  const first = segments[0]
  // Within a multi-segment reference, a host has a dot or a port, or is exactly
  // "localhost". Anything else is a Docker Hub namespace, e.g. "codemowers/util".
  const looksLikeHost = first.includes(".") || first.includes(":") || first === "localhost"
  return looksLikeHost ? first : DOCKER_HUB
}

// Registries that are never a push target for a tenant, so they must not be
// mistaken for the house registry just because they serve many images.
const UPSTREAM_REGISTRIES = new Set([
  DOCKER_HUB,
  "registry.k8s.io",
  "gcr.io",
  "k8s.gcr.io",
  "quay.io",
  "ghcr.io",
  "mcr.microsoft.com",
  "public.ecr.aws",
  "mirror.gcr.io",
])

export function isUpstream(host: string): boolean {
  return UPSTREAM_REGISTRIES.has(host)
}

export function summariseRegistries(images: string[], pullSecretRegistries: Set<string>): RegistryFact[] {
  const counts = new Map<string, number>()
  for (const image of images) {
    if (!image) continue
    const host = registryHostOf(image)
    counts.set(host, (counts.get(host) ?? 0) + 1)
  }

  // The house registry is the most-used one that is not a public upstream —
  // on these clusters that is zot.<region>.codemowers.io.
  let house: string | null = null
  let houseCount = 0
  for (const [host, count] of counts) {
    if (isUpstream(host)) continue
    if (count > houseCount) {
      house = host
      houseCount = count
    }
  }

  return [...counts.entries()]
    .map(([host, imageCount]) => ({
      host,
      imageCount,
      isHouseRegistry: host === house,
      requiresPullSecret: pullSecretRegistries.has(host),
    }))
    .sort((a, b) => Number(b.isHouseRegistry) - Number(a.isHouseRegistry) || b.imageCount - a.imageCount)
}

// A dockerconfigjson Secret's `auths` keys are the registries it authenticates
// to. We read the keys only — never a credential.
export function registriesInPullSecret(dockerConfigJson: string): string[] {
  try {
    const parsed = JSON.parse(dockerConfigJson) as { auths?: Record<string, unknown> }
    return Object.keys(parsed.auths ?? {}).map(key => {
      // Legacy entries are full URLs; the host is what matches an image.
      const withoutScheme = key.replace(/^https?:\/\//, "")
      return withoutScheme.split("/")[0]
    })
  } catch {
    return []
  }
}

export type PullSecretFact = { name: string; registries: string[] }

export type PushAdvice = {
  registry: string | null
  pullSecrets: PullSecretFact[]
  advice: string
}

export function pushAdvice(registries: RegistryFact[], pullSecrets: PullSecretFact[]): PushAdvice {
  const house = registries.find(r => r.isHouseRegistry) ?? null
  const covering = house ? pullSecrets.filter(s => s.registries.includes(house.host)) : []

  if (!house) {
    return {
      registry: null,
      pullSecrets,
      advice:
        "Every workload on this cluster pulls from a public registry, so there is no in-cluster " +
        "registry to push to. Ask the platform team where images should live.",
    }
  }

  if (covering.length === 0) {
    return {
      registry: house.host,
      pullSecrets,
      advice:
        `Push to ${house.host}, which is where this cluster's own workloads come from. This namespace has ` +
        "no imagePullSecret for it, so a private image would fail to pull with ImagePullBackOff — ask the " +
        "platform team for one, or push a publicly readable image. Note that image pulls are done by the " +
        "node, not your pod, so a network policy is not what fixes this.",
    }
  }

  return {
    registry: house.host,
    pullSecrets,
    advice:
      `Push to ${house.host}, and reference the ${covering[0].name} imagePullSecret in your pod spec. ` +
      "It already exists in this namespace.",
  }
}
