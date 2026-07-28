import { kubeApiGet } from "../k8s"

const RESOURCE_PATHS: Record<string, (namespace: string, name: string) => string> = {
  Pod: (ns, name) => `/api/v1/namespaces/${ns}/pods/${name}`,
  Deployment: (ns, name) => `/apis/apps/v1/namespaces/${ns}/deployments/${name}`,
  ReplicaSet: (ns, name) => `/apis/apps/v1/namespaces/${ns}/replicasets/${name}`,
  StatefulSet: (ns, name) => `/apis/apps/v1/namespaces/${ns}/statefulsets/${name}`,
  DaemonSet: (ns, name) => `/apis/apps/v1/namespaces/${ns}/daemonsets/${name}`,
}

export type ResourceObject = {
  metadata?: { uid?: string }
} & Record<string, unknown>

export async function getResourceObject(
  kind: string,
  namespace: string,
  name: string,
): Promise<ResourceObject | null> {
  const buildPath = RESOURCE_PATHS[kind]
  if (!buildPath) return null
  return await kubeApiGet<ResourceObject>(
    buildPath(encodeURIComponent(namespace), encodeURIComponent(name)),
  )
}
