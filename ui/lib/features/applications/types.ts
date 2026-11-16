export type ArgoAppRef = { name: string; url?: string; kind?: string; resourceRef?: string }

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
