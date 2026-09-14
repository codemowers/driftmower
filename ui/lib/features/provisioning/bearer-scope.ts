// Namespace scoping for a bearer-authenticated caller (driftmower-mcp, the
// platform's MCP gateway) rather than a browser session.
//
// Pure and relative-import only, like the rest of this directory: the test
// runner strips types with Node and does not resolve the `@/*` alias, and this
// must stay testable without a cluster. It is the filter that decides whether
// one tenant can read another's quota, so it gets tests.

export type BearerScopeInput = {
  // Namespaces from the token's `codemowers.io/namespaces` claim. `undefined`
  // means the token carried no claim at all.
  claimNamespaces: string[] | undefined
}

// Why an absent claim yields no access rather than full access: dropping the
// `namespaces` scope from the OIDCClient is a plausible misconfiguration, and
// failing open would silently hand every caller every namespace. Failing closed
// makes the mistake visible as "you see nothing" instead of invisible as "you
// see everything".
export function permittedNamespacesForBearer(asked: string[], input: BearerScopeInput): string[] {
  const allowed = input.claimNamespaces ?? []

  return asked.filter((namespace) => allowed.includes(namespace))
}

// Distinguishes the two ways a bearer caller ends up seeing nothing, because
// they need different fixes: a missing claim is a token problem, an empty one
// is an authorization answer.
export function bearerScopeState(
  input: BearerScopeInput
): "claim-missing" | "no-namespaces" | "scoped" {
  if (input.claimNamespaces === undefined) return "claim-missing"

  return input.claimNamespaces.length === 0 ? "no-namespaces" : "scoped"
}
