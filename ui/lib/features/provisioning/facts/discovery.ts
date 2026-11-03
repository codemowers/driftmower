import "server-only"

import { kubeApiGet } from "@/lib/server/k8s"
import { createTtlCache } from "@/lib/utils/ttl-cache"
import { CLUSTER_FACT_TTL_MS } from "../constants"
import {
  fromAggregated,
  fromResourceLists,
  groupVersionsOf,
  isAggregated,
  type AggregatedList,
  type ApiSurface,
  type GroupList,
  type ResourceList,
} from "../api-surface"

// The cheapest fact we have: `system:discovery` grants get on /apis and /apis/*
// to system:authenticated, which includes every ServiceAccount. No new RBAC.

// Aggregated discovery (k8s >= 1.30) returns every group, version, kind, plural
// and scope in ONE request. Older clusters fall back to /apis plus a GET per
// group — ~30 requests, acceptable behind a 5 minute TTL.
const AGGREGATED_ACCEPT =
  "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,application/json"

async function loadApiSurface(): Promise<ApiSurface> {
  const raw = await kubeApiGet<AggregatedList | GroupList>("/apis", AGGREGATED_ACCEPT)
  if (isAggregated(raw)) return fromAggregated(raw)

  const pending = groupVersionsOf(raw)
  const lists = await Promise.all(
    pending.map(async ({ group, version }) => ({
      group,
      version,
      // A group can vanish between the /apis listing and this GET.
      list: await kubeApiGet<ResourceList>(`/apis/${group}/${version}`).catch(() => null),
    })),
  )
  return fromResourceLists(lists)
}

export const getApiSurface = createTtlCache(CLUSTER_FACT_TTL_MS, loadApiSurface)
