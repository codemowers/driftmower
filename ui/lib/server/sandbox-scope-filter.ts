import "server-only"

import { fetchSandboxScope, type SandboxScope } from "./platform-manager-proxy"
import { namespaceAllowList, seesClusterWideViews, writeVerdict } from "./scope-rules"

// READ path. null means every namespace is readable: without a usable tenancy
// control plane, nothing narrows.
//
// Deliberately not reused for writes. Widening a listing when scope is
// indeterminate shows a user rows they may not be entitled to; doing the same on
// a write lets them change another sandbox's workloads, which is a different
// kind of mistake. guardNamespace draws that line -- see scope-rules.ts for
// which states mean what.
export function namespaceFilter(scope: SandboxScope): ((namespace: string) => boolean) | null {
  const permitted = namespaceAllowList(scope)
  return permitted && (namespace => permitted.has(namespace))
}

// WRITE path: may this caller act on this namespace? Returns a Response to send
// back, or null to proceed.
export async function guardNamespace(namespace: string): Promise<Response | null> {
  const verdict = writeVerdict(await fetchSandboxScope(), namespace)
  if (verdict.allow) return null
  return Response.json({ error: verdict.reason }, { status: verdict.status })
}

// VIEW path: the answer behind hiding the Cluster overview -- both its nav entry
// and the route itself -- from sandbox users.
export async function callerSeesClusterWideViews(): Promise<boolean> {
  return seesClusterWideViews(await fetchSandboxScope())
}
