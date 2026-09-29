// PURE. Turning a StorageClass into the one thing a beginner needs to know:
// can this volume move to another machine, or not? On a node-local class
// "3 instances" is three copies of the data rather than storage that survives
// losing a node.

import type { StorageClassFact, StorageTopology } from './types.js'

// A volume that only one node can mount. The pod is pinned for life.
const NODE_LOCAL_PROVISIONERS = new Set([
  'zfs.csi.openebs.io',
  'topolvm.io',
  'topolvm.cybozu.com',
  'openebs.io/local',
  'local.csi.openebs.io',
  'rancher.io/local-path',
  'kubernetes.io/no-provisioner',
  // Dev clusters. minikube is a supported local target for this app, and its
  // default class is hostpath, so classifying it keeps the local experience
  // honest rather than "unrecognised provisioner".
  'k8s.io/minikube-hostpath',
  'docker.io/hostpath'
])

// A volume any node in the same zone can mount, but no node outside it.
const ZONAL_PROVISIONERS = new Set([
  'ebs.csi.aws.com',
  'kubernetes.io/aws-ebs',
  'disk.csi.azure.com',
  'pd.csi.storage.gke.io',
  'kubernetes.io/gce-pd',
  'cinder.csi.openstack.org',
  'csi.hetzner.cloud'
])

// A volume any node can mount, wherever it is.
const CLUSTER_WIDE_PROVISIONERS = new Set([
  'rook-ceph.rbd.csi.ceph.com',
  'rook-ceph.cephfs.csi.ceph.com',
  'cephfs.csi.ceph.com',
  'rbd.csi.ceph.com',
  'driver.longhorn.io',
  'nfs.csi.k8s.io',
  'efs.csi.aws.com',
  'file.csi.azure.com'
])

export function classifyTopology(provisioner: string): StorageTopology {
  if (NODE_LOCAL_PROVISIONERS.has(provisioner)) return 'node-local'

  if (ZONAL_PROVISIONERS.has(provisioner)) return 'zonal'

  if (CLUSTER_WIDE_PROVISIONERS.has(provisioner)) return 'cluster-wide'

  return 'unknown'
}

// Whether two instances can live on this class and still be rescheduled by
// their operator. Node-local storage is the case that surprises people.
export function isReplicaSafe(topology: StorageTopology): boolean {
  return topology === 'cluster-wide' || topology === 'zonal'
}

const TOPOLOGY_CLAUSE: Record<StorageTopology, string> = {
  'node-local': "lives on one machine's disks, so a pod using it can only ever run on that machine",
  zonal: 'lives in one zone, so a pod using it can only run on nodes in that zone',
  'cluster-wide': 'can be mounted by any node, so a pod using it can be rescheduled anywhere',
  unknown: 'has an unrecognised provisioner, so we cannot tell whether the volume can move'
}

export function impliesClause(fact: {
  topology: StorageTopology
  reclaimPolicy: StorageClassFact['reclaimPolicy']
  allowExpansion: boolean
  bindingMode: StorageClassFact['bindingMode']
}): string {
  const parts = [TOPOLOGY_CLAUSE[fact.topology]]

  if (fact.reclaimPolicy === 'Retain') {
    parts.push('keeps the data after you delete the database')
  }

  if (!fact.allowExpansion) {
    parts.push('cannot be resized later')
  }

  // Immediate binding on node-local storage is the trap: the volume can be
  // created on a node the pod is then not schedulable to.
  if (fact.topology === 'node-local' && fact.bindingMode === 'Immediate') {
    parts.push('binds before a pod is scheduled, so the volume can land on a node the pod cannot use')
  }

  return parts.join('; ')
}

export type RawStorageClass = {
  metadata?: { name?: string; annotations?: Record<string, string> }
  provisioner?: string
  reclaimPolicy?: string
  allowVolumeExpansion?: boolean
  volumeBindingMode?: string
}

const DEFAULT_ANNOTATION = 'storageclass.kubernetes.io/is-default-class'

function reclaimOf(value: string | undefined): StorageClassFact['reclaimPolicy'] {
  // The API defaults reclaimPolicy to Delete when unset.
  return value === 'Retain' || value === 'Recycle' ? value : 'Delete'
}

export function toStorageClassFact(raw: RawStorageClass): StorageClassFact | null {
  const name = raw.metadata?.name
  const provisioner = raw.provisioner

  if (!name || !provisioner) return null

  const topology = classifyTopology(provisioner)
  // The API defaults volumeBindingMode to Immediate when unset.
  const bindingMode = raw.volumeBindingMode === 'WaitForFirstConsumer' ? 'WaitForFirstConsumer' : 'Immediate'
  const reclaimPolicy = reclaimOf(raw.reclaimPolicy)
  const allowExpansion = raw.allowVolumeExpansion === true

  return {
    name,
    provisioner,
    isDefault: raw.metadata?.annotations?.[DEFAULT_ANNOTATION] === 'true',
    bindingMode,
    allowExpansion,
    reclaimPolicy,
    topology,
    implies: impliesClause({ topology, reclaimPolicy, allowExpansion, bindingMode }),
    replicaSafe: isReplicaSafe(topology)
  }
}

// The shape this server's cluster catalog already produces for a StorageClass
// (src/clients/cluster-catalog.ts), so the fact is derived from one read.
export function storageFactFromCatalog(item: {
  name: string
  provisioner: string | null
  reclaimPolicy: string | null
  volumeBindingMode: string | null
  allowVolumeExpansion: boolean
  isDefault: boolean
}): StorageClassFact | null {
  return toStorageClassFact({
    metadata: {
      name: item.name,
      annotations: item.isDefault ? { [DEFAULT_ANNOTATION]: 'true' } : {}
    },
    provisioner: item.provisioner ?? undefined,
    reclaimPolicy: item.reclaimPolicy ?? undefined,
    allowVolumeExpansion: item.allowVolumeExpansion,
    volumeBindingMode: item.volumeBindingMode ?? undefined
  })
}

// Resolves a recipe's preference list against what the cluster has, falling
// back to the cluster default. Returning null is a blocker, not a guess.
export function resolveStorageClass(
  classes: StorageClassFact[],
  preference: string[],
  requested?: string | null
): StorageClassFact | null {
  if (requested) return classes.find(c => c.name === requested) ?? null

  for (const name of preference) {
    const match = classes.find(c => c.name === name)

    if (match) return match
  }

  return classes.find(c => c.isDefault) ?? null
}
