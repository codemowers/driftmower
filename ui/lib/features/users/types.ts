// Shapes returned by MCP's list_oidc_users, list_service_accounts and the
// access tools.

export type OIDCUser = {
  name: string
  namespace: string
  type?: string
  displayName?: string
  primaryEmail?: string
  emails: string[]
  groups: string[]
  memberships?: GroupMembership[]
  localEmail?: string
  companyEmail?: string
  localDisplayName?: string
  approved?: boolean
  passkeyCount: number
  lastSignIn?: string
  lastApplication?: string
}

export type GroupMembership = { prefix: string; name: string; source: string; local: boolean }

// The account behind a Kubernetes username, as far as MCP can tell.
export type Subject = {
  username: string
  oidcUser?: string
  serviceAccount?: { namespace: string; name: string }
}

export type ServiceAccount = {
  namespace: string
  name: string
  createdAt: string
  createdBy?: Subject
  // A RoleBinding or ClusterRoleBinding names it.
  bound: boolean
}

export type Grant = {
  group: string
  resource: string
  kind?: string
  clusterScoped?: boolean
  resourceNames?: string[]
  verbs: string[]
  namespaces?: string[]
}

export type NonResourceGrant = { urls: string[]; verbs: string[] }

export type UserAccess = {
  user: OIDCUser
  identity: { user: string; groups: string[] | null }
  clusterAdmin: boolean
  clusterWide: Grant[]
  nonResourceURLs: NonResourceGrant[]
  namespaced: Grant[]
  examined: string[]
  totalNamespaces: number
  incomplete: string[]
  warnings: string[]
  evaluatedAt: string
}

// MCP registers these tools only when user access is enabled on the server.
export function userAccessError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e)
  return /unknown tool|not found/i.test(message)
    ? "This MCP server does not serve OIDC users (mcp.userAccess.enabled is off)."
    : message
}

export function formatSignIn(value?: string): string {
  if (!value) return "Never"
  const minutes = Math.floor((Date.now() - new Date(value).getTime()) / 60_000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? "Yesterday" : `${days} days ago`
}
