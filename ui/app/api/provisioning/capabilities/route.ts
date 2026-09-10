import { getSession } from "@/lib/auth/session"
import { OFFERINGS_BY_ID } from "@/lib/features/provisioning/catalog/offerings"
import { denialsFor } from "@/lib/features/provisioning/admission-facts"
import { getAdmissionFacts } from "@/lib/features/provisioning/facts/admission"
import { getNamespaceFacts } from "@/lib/features/provisioning/facts/namespace"
import { hostRuleFor } from "@/lib/features/provisioning/ingress-facts"
import { gatherClusterFacts } from "@/lib/features/provisioning/facts"
import type { CapabilityResponse, NamespaceFact, OfferingId } from "@/lib/features/provisioning/types"
import { fetchSandboxScope } from "@/lib/server/platform-manager-proxy"

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

  const [cluster, scope] = await Promise.all([gatherClusterFacts(), fetchSandboxScope()])

  if (!cluster.inCluster) {
    return Response.json(cluster satisfies CapabilityResponse, { headers: NO_STORE })
  }

  // Scope namespace reads to the caller's tenancy. An admin gets whatever they
  // asked for; anyone else is confined to their own namespaces, so a crafted
  // ?ns= cannot read another sandbox's quota.
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

  const admission = await getAdmissionFacts()
  const admissionFacts = admission.known ? admission.value : []

  const results = await Promise.all(
    targets.map(async namespace => {
      const facts = await getNamespaceFacts({
        namespace,
        offeringLabelKey: spec ? (OFFERING_LABEL_KEY[spec.id] ?? "app") : null,
        target: spec ? { group: spec.group, plural: pluralFor(cluster, spec.id) } : null,
        caller,
        // An admission policy overrides RBAC, so the permission verdict has to
        // see these or it answers optimistically for anything a guard denies.
        admissionFacts,
      })
      return { namespace, facts }
    }),
  )

  const hostRules: CapabilityResponse["ingress"]["hostRules"] = []

  for (const { namespace, facts } of results) {
    namespaces.push(facts.fact)
    for (const entry of facts.degraded) {
      // One row per fact family, not per namespace: the fix is the same rule.
      if (!degraded.some(d => d.source === entry.source)) degraded.push(entry)
    }

    hostRules.push(hostRuleFrom(cluster, facts.fact.sandbox, namespace, admissionFacts))

  }

  return Response.json(
    {
      ...cluster,
      namespaces,
      ingress: { ...cluster.ingress, hostRules },
      degraded,
    } satisfies CapabilityResponse,
    { headers: NO_STORE },
  )
}

// The hostname a namespace may claim. A namespace that is not a sandbox is not
// governed by the guard, so it gets a different note rather than a fabricated
// pattern.
function hostRuleFrom(
  cluster: CapabilityResponse,
  sandboxId: string | null,
  namespace: string,
  admissionFacts: Parameters<typeof denialsFor>[0],
): CapabilityResponse["ingress"]["hostRules"][number] {
  const suffix = cluster.ingress.domainSuffix
  const guard = denialsFor(admissionFacts, {
    group: "networking.k8s.io",
    resource: "ingresses",
    operation: "CREATE",
    namespaceLabels: sandboxId ? { "codemowers.io/sandbox": sandboxId } : {},
  })[0]
  // The message about hosts, not the one about IngressRoute: the guard carries
  // both, and only the first explains a rejected hostname.
  const hostMessage = guard?.messages.find(m => /host/i.test(m)) ?? guard?.messages[0] ?? null

  if (!sandboxId || !suffix) {
    return {
      namespace,
      sandboxId,
      exactHost: null,
      labelledPattern: null,
      enforcedBy: guard?.policy ?? null,
      enforcedMessage: hostMessage,
      note: !suffix
        ? "This cluster publishes no ingress domain and none could be derived from this app's own address, so ask the platform team which hostnames you may use."
        : "This namespace is not a sandbox, so the sandbox hostname rule does not apply to it.",
    }
  }

  const rule = hostRuleFor(suffix, sandboxId, guard?.policy ?? null)
  // A derived suffix comes from this app's own hostname rather than from the
  // guard's configured parameter, so it could differ from what admission
  // compares against. Saying which one you got is the difference between a
  // hostname you can rely on and one worth checking.
  const derived = cluster.ingress.domainSuffixSource === "app-base-url"
  const provenance = derived
    ? " The domain is taken from this app's own address because the guard's configured domain could not be read, so confirm it before relying on it."
    : ""

  return {
    namespace,
    sandboxId,
    exactHost: rule.exactHost,
    labelledPattern: rule.labelledPattern,
    enforcedBy: rule.enforcedBy,
    enforcedMessage: hostMessage,
    note:
      (rule.enforcedBy
        ? `Only these hostnames are accepted here, and the ${rule.enforcedBy} admission policy enforces it — the ingress controller is shared, and the sandbox-id prefix is what keeps one tenant from claiming another's traffic.`
        : "These are the hostnames this namespace's sandbox id maps to.") + provenance,
  }
}

// The plural comes from discovery rather than the recipe, so the permission
// hint names the resource this cluster actually serves.
function pluralFor(cluster: CapabilityResponse, id: OfferingId): string {
  const card = cluster.offerings.find(o => o.id === id)
  return card?.resource?.split(".")[0] ?? ""
}
