import { toTopologyFact, type RawNode } from '../../domain/provisioning/topology-facts.js'
import type { Fact, TopologyFact } from '../../domain/provisioning/types.js'
import { collect } from '../kubernetes-list.js'
import type { KubernetesReader } from '../observability-kubernetes.js'
import { optional } from './tolerate.js'

// Node objects are large (images, conditions), and the requester caps a
// response at 4 MiB, so page in small batches.
export function loadTopology(read: KubernetesReader): Promise<Fact<TopologyFact>> {
  return optional('nodes', async () =>
    toTopologyFact(
      await collect(read, '/api/v1/nodes', item => item as RawNode, {
        limit: 50,
        maxPages: 200,
        what: 'Node listing'
      })
    )
  )
}
