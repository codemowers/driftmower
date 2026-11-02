// PURE. What hostname a user may actually claim, which on these clusters is
// not a convention but an admission rule — and one they cannot guess, because
// a sandbox id begins with a creation-time random hash (`<hash6>-<name>`).
//
// The rule, from platform-manager/deploy/sandbox-guard.yaml: a host must be
// exactly `<sandbox-id>.<suffix>` or `<sandbox-id>-<label>.<suffix>`, with no
// further dots in the label. Wildcards, catch-all defaultBackends and host-less
// rules are rejected, and Traefik IngressRoute is denied outright.

export type IngressHostRule = {
  // From the guard's parameter ConfigMap, e.g. "ee-lte-1.codemowers.io".
  domainSuffix: string
  sandboxId: string
  // The two hostnames the guard accepts, spelled out.
  exactHost: string
  labelledPattern: string
  enforcedBy: string | null
}

export function hostRuleFor(
  domainSuffix: string,
  sandboxId: string,
  enforcedBy: string | null,
): IngressHostRule {
  return {
    domainSuffix,
    sandboxId,
    exactHost: `${sandboxId}.${domainSuffix}`,
    labelledPattern: `${sandboxId}-<label>.${domainSuffix}`,
    enforcedBy,
  }
}

// Mirrors the guard's CEL so the UI can reject a host before the apiserver
// does. Kept deliberately close to the original expression: exact match, or
// prefix `<id>-` plus the suffix, with the middle segment containing no dot.
export function hostIsAllowed(host: string, rule: IngressHostRule): boolean {
  if (host.startsWith("*")) return false

  const suffix = `.${rule.domainSuffix}`
  if (host === rule.exactHost) return true
  if (!host.startsWith(`${rule.sandboxId}-`)) return false
  if (!host.endsWith(suffix)) return false

  const middle = host.slice(rule.sandboxId.length + 1, host.length - suffix.length)
  return middle.length > 0 && !middle.includes(".")
}

export function hostRejectionReason(host: string, rule: IngressHostRule): string | null {
  if (hostIsAllowed(host, rule)) return null
  if (host.startsWith("*")) {
    return "Wildcard hosts are rejected: the ingress controller is shared, so a wildcard would claim other sandboxes' hostnames too."
  }
  return (
    `Hosts here must be ${rule.exactHost} or ${rule.labelledPattern} — anchored on your sandbox id, ` +
    "because the ingress controller is shared and the prefix is what stops one sandbox claiming another's traffic."
  )
}

// The app is itself deployed at <name>.<suffix>, so its own public URL carries
// the answer — no cluster read and no RBAC. It is still a derivation: a
// deployment that does not follow the one-label convention would produce the
// wrong suffix. The provisioning page uses driftmower-mcp's domainSuffix,
// which reads the guard's own parameter; this serves the applications list.
export function suffixFromAppBaseUrl(appBaseUrl: string | undefined): string | null {
  if (!appBaseUrl) return null

  let hostname: string
  try {
    hostname = new URL(appBaseUrl).hostname
  } catch {
    return null
  }

  const labels = hostname.split(".").filter(Boolean)
  // Dropping the app's own label has to leave a real domain behind. An apex
  // deployment (example.com) or a bare host has no suffix to offer.
  if (labels.length < 3) return null
  return labels.slice(1).join(".")
}
