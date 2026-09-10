import { getSession } from "@/lib/auth/session"
import { OFFERINGS_BY_ID } from "@/lib/features/provisioning/catalog/offerings"
import { getNamespaceFacts } from "@/lib/features/provisioning/facts/namespace"
import { gatherClusterFacts } from "@/lib/features/provisioning/facts"
import type { CapabilityResponse, NamespaceFact, OfferingId } from "@/lib/features/provisioning/types"
import { fetchTenantScope } from "@/lib/server/platform-manager-proxy"

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

// Namespace facts are per-namespace GETs, so a stale deep link naming fifty
// namespaces must not fan out unbounded.
const MAX_NAMESPACES = 12

// The offering label whose network coverage we evaluate. Only cnpg has the
// name-specific policy problem today, but the check is generic.
const OFFERING_LABEL_KEY: Partial<Record<OfferingId, string>> = {
  postgres: "cnpg.io/cluster",
  dragonfly: "app",
  mongodb: "app",
}

function requested(url: URL, key: string): string[] {
  const raw = url.searchParams.get(key)
  if (!raw) return []
  return [...new Set(raw.split(",").map(v => v.trim()).filter(Boolean))]
}

export async function GET(req: Request) {
  const url = new URL(req.url)
  const offering = url.searchParams.get("offering") as OfferingId | null
  const spec = offering ? OFFERINGS_BY_ID.get(offering) : undefined

  const [cluster, scope] = await Promise.all([gatherClusterFacts(), fetchTenantScope()])

  if (!cluster.inCluster) {
    return Response.json(cluster satisfies CapabilityResponse, { headers: NO_STORE })
  }

  // Scope namespace reads to the caller's tenancy. An admin gets whatever they
  // asked for; anyone else is confined to their own namespaces, so a crafted
  // ?ns= cannot read another tenant's quota.
  const asked = requested(url, "ns")
  const permitted =
    scope.state === "ok" && !scope.admin ? asked.filter(n => scope.namespaces.includes(n)) : asked
  const targets = permitted.slice(0, MAX_NAMESPACES)

  const session = await getSession()
  const claims = session.claims
  const caller = claims
    ? {
        sub: claims.sub,
        groups: claims.groups,
        // These clusters set no --oidc-username-prefix, so the apiserver's
        // username is "<issuer>#<sub>". The bare sub is tried too.
        usernamePrefixes: [`${process.env.OIDC_IDP_URI ?? ""}#`, ""],
      }
    : null

  const namespaces: NamespaceFact[] = []
  const degraded = [...cluster.degraded]

  const results = await Promise.all(
    targets.map(namespace =>
      getNamespaceFacts({
        namespace,
        offeringLabelKey: spec ? (OFFERING_LABEL_KEY[spec.id] ?? "app") : null,
        target: spec ? { group: spec.group, plural: pluralFor(cluster, spec.id) } : null,
        caller,
      }),
    ),
  )

  for (const result of results) {
    namespaces.push(result.fact)
    for (const entry of result.degraded) {
      // One row per fact family, not per namespace: the fix is the same rule.
      if (!degraded.some(d => d.source === entry.source)) degraded.push(entry)
    }
  }

  return Response.json({ ...cluster, namespaces, degraded } satisfies CapabilityResponse, { headers: NO_STORE })
}

// The plural comes from discovery rather than the recipe, so the permission
// hint names the resource this cluster actually serves.
function pluralFor(cluster: CapabilityResponse, id: OfferingId): string {
  const card = cluster.offerings.find(o => o.id === id)
  return card?.resource?.split(".")[0] ?? ""
}
