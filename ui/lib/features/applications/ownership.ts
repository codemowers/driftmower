// PURE. Which of passmower's registered apps are the caller's own.
//
// The launcher half of the Applications page is never narrowed by tenancy --
// passmower filters /api/apps by group and the UI trusts that. A registration
// that outlives the app it points at, or names a group broader than it meant to,
// therefore reaches sandbox users as a tile: the platform's own Prometheus, its
// Alertmanager, a Thanos host whose workload was removed years ago. Sandbox
// users have their own Prometheus (`<id>-prom`), so these are not merely dead
// links, they are the wrong instance.
//
// The rule is the sandbox ingress guard's, reused: a hostname this caller could
// have claimed is theirs, anything else on the cluster domain is the platform's.

// Relative with the extension, like the other pure modules here: the unit
// tests run under `node --test`, whose resolver knows neither the `@/` alias
// nor extensionless specifiers.
import { hostIsAllowed, hostRuleFor } from "../provisioning/ingress-facts.ts"
import { hostOf } from "./host-url.ts"
import type { ApplicationEntry } from "./types.ts"

export function hostBelongsToSandboxes(
  host: string,
  sandboxIds: string[],
  domainSuffix: string,
): boolean {
  return sandboxIds.some(id => hostIsAllowed(host, hostRuleFor(domainSuffix, id, null)))
}

// Only hostnames on the cluster's own domain are judged. passmower legitimately
// advertises apps that live nowhere near this cluster, and "not anchored on your
// sandbox id" says nothing useful about github.com or a hosted SaaS tool --
// applying the rule there would hide apps that were never the platform's to
// begin with.
export function isPlatformHost(
  host: string,
  sandboxIds: string[],
  domainSuffix: string,
): boolean {
  if (!host.endsWith(`.${domainSuffix}`)) return false
  return !hostBelongsToSandboxes(host, sandboxIds, domainSuffix)
}

// Returns the entries a sandbox user should be offered. Nothing is hidden when
// the domain suffix is unknown: guessing wrong here empties someone's launcher,
// which is a worse failure than the stale tile this removes.
export function ownApps(
  entries: ApplicationEntry[],
  sandboxIds: string[],
  domainSuffix: string | null,
): ApplicationEntry[] {
  if (!domainSuffix) return entries

  return entries.filter(entry => {
    const host = hostOf(entry.url)
    // An unparseable url cannot be attributed, so leave it where it is.
    return host === null || !isPlatformHost(host, sandboxIds, domainSuffix)
  })
}
