import "server-only"

export type ManagerInfo = {
  managerUID: string
  argoApp?: { name: string; url?: string; kind?: string; resourceRef?: string }
}

export function managerFromAnnotations(
  annotations: Record<string, string> | undefined,
  argoUrl: string | undefined,
): ManagerInfo | undefined {
  if (!annotations) return undefined

  const releaseName = annotations["meta.helm.sh/release-name"]
  const releaseNamespace = annotations["meta.helm.sh/release-namespace"]
  if (releaseName && releaseNamespace) {
    return { managerUID: `helm-release:${releaseNamespace}:${releaseName}` }
  }

  const trackingId = annotations["argocd.argoproj.io/tracking-id"]
  if (trackingId) {
    const parts = trackingId.split(":")
    const appName = parts[0]
    if (appName) {
      const managerUID = `argo-app:argocd:${appName}`
      const argoApp: { name: string; url?: string; kind?: string; resourceRef?: string } = {
        name: appName,
      }
      if (parts.length >= 3) {
        argoApp.kind = parts[1].split("/").pop()
        argoApp.resourceRef = parts[2]
      }
      if (argoUrl) argoApp.url = buildArgoUrl(parts, argoUrl)
      return { managerUID, argoApp }
    }
  }

  return undefined
}

function buildArgoUrl(parts: string[], argoUrl: string): string {
  const appUrl = `${argoUrl}/applications/argocd/${parts[0]}`
  if (parts.length < 3) return appUrl
  const node = encodeURIComponent(`${parts.slice(1).join("/")}/0`)
  return `${appUrl}?view=tree&orphaned=false&resource=&node=${node}`
}
