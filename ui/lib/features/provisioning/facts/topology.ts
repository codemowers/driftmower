import "server-only"

import { kubeApiGet } from "@/lib/server/k8s"
import { createTtlCache } from "@/lib/utils/ttl-cache"
import { TOPOLOGY_TTL_MS } from "../constants"
import { toTopologyFact, type RawNode } from "../topology-facts"
import type { Fact, TopologyFact } from "../types"
import { optional } from "./tolerate"

// Nodes are already granted to this ServiceAccount (k8s/rbac.yaml), but
// lib/cluster-resources/nodes.ts discards allocatable, zone labels and taints,
// so this reads them again rather than widening that response's contract.
async function loadTopology(): Promise<Fact<TopologyFact>> {
  return await optional("nodes", async () => {
    const list = await kubeApiGet<{ items?: RawNode[] }>("/api/v1/nodes")
    return toTopologyFact(list.items ?? [])
  })
}

export const getTopology = createTtlCache(TOPOLOGY_TTL_MS, loadTopology)
