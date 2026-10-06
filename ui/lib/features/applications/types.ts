export type ArgoAppRef = { name: string; url?: string; kind?: string; resourceRef?: string }

export type HostEntry = {
  host: string
  url: string
  name: string
  namespace: string
  ingressNames: string[]
  managerUID?: string
  argoApp?: ArgoAppRef
}

// Anything but "ok" means the inventory is incomplete rather than absent.
export type TenancyState = "ok" | "not-configured" | "no-session" | "rejected" | "unreachable"

// domainSuffix is the cluster's hosting domain when the deployment sets
// DOMAIN_SUFFIX; absent or null means the page derives it from its own host.
export type HostsResponse = { hosts: HostEntry[]; tenancy: TenancyState; domainSuffix?: string | null }

export type OidcApp = {
  name: string
  url: string
  groups: string[]
  displayOrder: number
  // Markdown pre-rendered to sanitized HTML by passmower.
  description: string | null
  metadata: unknown
}

export type ApplicationEntry = {
  key: string
  name: string
  url: string
  namespace: string | null
  groups: string[]
  description: string | null
  managerUID?: string
  argoApp?: ArgoAppRef
}

export type ManagerLink =
  | {
    kind: "helm"
    release: string
    namespace: string
    uid: string | null
    chartName: string
    chartVersion: string
    chartAppVersion: string
    latestChartTag?: string
  }
  | { kind: "argo"; name: string; url?: string }
