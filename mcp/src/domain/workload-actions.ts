// Explicit adapters: unknown operators must not inherit rollout semantics.
export function restartResource(
  apiVersion: string,
  kind: string
): {
  resource: string
  base: string
  annotationPath: string[]
  crd?: string
} | null {
  if (apiVersion === 'apps/v1') {
    const resource = { Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets' }[kind]

    if (resource)
      return {
        resource,
        base: '/apis/apps/v1',
        annotationPath: ['spec', 'template', 'metadata', 'annotations']
      }
  }

  if (apiVersion === 'postgresql.cnpg.io/v1' && kind === 'Cluster')
    return {
      resource: 'clusters',
      base: '/apis/postgresql.cnpg.io/v1',
      annotationPath: ['metadata', 'annotations']
    }

  if (
    ['cluster.redpanda.com/v1alpha1', 'cluster.redpanda.com/v1alpha2'].includes(apiVersion) &&
    kind === 'Redpanda'
  )
    return {
      resource: 'redpandas',
      base: `/apis/${apiVersion}`,
      crd: 'redpandas.cluster.redpanda.com',
      annotationPath: ['spec', 'clusterSpec', 'statefulset', 'podTemplate', 'annotations']
    }

  if (apiVersion === 'dragonflydb.io/v1alpha1' && kind === 'Dragonfly')
    return {
      resource: 'dragonflies',
      base: `/apis/${apiVersion}`,
      crd: 'dragonflies.dragonflydb.io',
      annotationPath: ['spec', 'annotations']
    }

  return null
}
