import {
  fromAggregated,
  fromResourceLists,
  groupVersionsOf,
  isAggregated,
  mergeSurfaces,
  type AggregatedList,
  type ApiSurface,
  type GroupList,
  type ResourceList
} from '../../domain/provisioning/api-surface.js'
import type { KubernetesReader } from '../observability-kubernetes.js'

// The cheapest fact there is: `system:discovery` grants get on /api and /apis
// to every authenticated principal, so this needs no RBAC of its own.
//
// Aggregated discovery (Kubernetes >= 1.30) returns every version, kind,
// plural and scope in one request per endpoint. The core group lives at /api
// and every named group at /apis, so both are read and merged. Older clusters
// fall back to one GET per group version.
export const AGGREGATED_ACCEPT =
  'application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json'

export async function loadApiSurface(read: KubernetesReader): Promise<ApiSurface> {
  const [core, named] = await Promise.all([loadCoreSurface(read), loadNamedSurface(read)])

  return mergeSurfaces(core, named)
}

type CoreVersions = { versions?: string[] }

async function loadCoreSurface(read: KubernetesReader): Promise<ApiSurface> {
  const raw = JSON.parse(await read('/api', AGGREGATED_ACCEPT)) as AggregatedList | CoreVersions

  if (isAggregated(raw as AggregatedList | GroupList)) return fromAggregated(raw as AggregatedList)

  const versions = (raw as CoreVersions).versions ?? ['v1']
  const lists = await Promise.all(
    versions.map(async version => ({
      group: '',
      version,
      list: await read(`/api/${version}`)
        .then(body => JSON.parse(body) as ResourceList)
        .catch(() => null)
    }))
  )

  return fromResourceLists(lists)
}

async function loadNamedSurface(read: KubernetesReader): Promise<ApiSurface> {
  const raw = JSON.parse(await read('/apis', AGGREGATED_ACCEPT)) as AggregatedList | GroupList

  if (isAggregated(raw)) return fromAggregated(raw)

  const lists = await Promise.all(
    groupVersionsOf(raw).map(async ({ group, version }) => ({
      group,
      version,
      // A group can vanish between the /apis listing and this GET.
      list: await read(`/apis/${group}/${version}`)
        .then(body => JSON.parse(body) as ResourceList)
        .catch(() => null)
    }))
  )

  return fromResourceLists(lists)
}
