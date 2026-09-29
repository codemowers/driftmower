import {
  fromAggregated,
  fromResourceLists,
  groupVersionsOf,
  isAggregated,
  type AggregatedList,
  type ApiSurface,
  type GroupList,
  type ResourceList
} from '../../domain/provisioning/api-surface.js'
import type { KubernetesReader } from '../observability-kubernetes.js'

// The cheapest fact there is: `system:discovery` grants get on /apis to every
// authenticated principal, so this needs no RBAC of its own.
//
// Aggregated discovery (Kubernetes >= 1.30) returns every group, version,
// kind, plural and scope in one request. Older clusters fall back to /apis
// plus one GET per group version.
export const AGGREGATED_ACCEPT =
  'application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json'

export async function loadApiSurface(read: KubernetesReader): Promise<ApiSurface> {
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
