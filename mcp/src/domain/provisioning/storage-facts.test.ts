import { expect, it } from 'vitest'

import {
  classifyTopology,
  impliesClause,
  isReplicaSafe,
  resolveStorageClass,
  storageFactFromCatalog,
  toStorageClassFact
} from './storage-facts.js'

// The real thing, from codemowers-kube/kube-system-bootstrap/templates/zfs.yaml:
// reclaimPolicy Retain, expansion on, and no volumeBindingMode at all.
const CODEMOWERS_POSTGRES = {
  metadata: { name: 'postgres' },
  provisioner: 'zfs.csi.openebs.io',
  reclaimPolicy: 'Retain',
  allowVolumeExpansion: true
}

it('classifies the provisioners that actually appear on these clusters', () => {
  expect(classifyTopology('zfs.csi.openebs.io')).toBe('node-local')
  expect(classifyTopology('topolvm.io')).toBe('node-local')
  expect(classifyTopology('ebs.csi.aws.com')).toBe('zonal')
  expect(classifyTopology('rook-ceph.rbd.csi.ceph.com')).toBe('cluster-wide')
  expect(classifyTopology('something.unknown.io')).toBe('unknown')
})

it('only zonal and cluster-wide storage lets an operator move an instance', () => {
  expect(isReplicaSafe('node-local')).toBe(false)
  // Unknown must not be treated as safe: that would turn a real blocker into silence.
  expect(isReplicaSafe('unknown')).toBe(false)
  expect(isReplicaSafe('zonal')).toBe(true)
  expect(isReplicaSafe('cluster-wide')).toBe(true)
})

it("the codemowers postgres class parses with the API's defaults applied", () => {
  const fact = toStorageClassFact(CODEMOWERS_POSTGRES)!

  expect(fact).toBeTruthy()
  expect(fact.topology).toBe('node-local')
  expect(fact.replicaSafe).toBe(false)
  expect(fact.reclaimPolicy).toBe('Retain')
  // volumeBindingMode is absent in the manifest; the API default is Immediate.
  expect(fact.bindingMode).toBe('Immediate')
  expect(fact.isDefault).toBe(false)
})

it('reclaimPolicy defaults to Delete when the manifest omits it', () => {
  const fact = toStorageClassFact({ metadata: { name: 'x' }, provisioner: 'ebs.csi.aws.com' })

  expect(fact?.reclaimPolicy).toBe('Delete')
  expect(fact?.allowExpansion).toBe(false)
})

it('a class without a name or provisioner is dropped rather than half-parsed', () => {
  expect(toStorageClassFact({ metadata: { name: 'x' } })).toBe(null)
  expect(toStorageClassFact({ provisioner: 'ebs.csi.aws.com' })).toBe(null)
})

it('the default-class annotation is read', () => {
  const fact = toStorageClassFact({
    metadata: { name: 'gp3', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } },
    provisioner: 'ebs.csi.aws.com'
  })

  expect(fact?.isDefault).toBe(true)
})

it('implies names every consequence that bites, including the Immediate trap', () => {
  const clause = toStorageClassFact(CODEMOWERS_POSTGRES)!.implies

  expect(clause).toMatch(/one machine's disks/)
  expect(clause).toMatch(/keeps the data after you delete/)
  expect(clause).toMatch(/binds before a pod is scheduled/)
})

it('WaitForFirstConsumer suppresses the binding warning but not the pinning one', () => {
  const clause = impliesClause({
    topology: 'node-local',
    reclaimPolicy: 'Delete',
    allowExpansion: true,
    bindingMode: 'WaitForFirstConsumer'
  })

  expect(clause).toMatch(/one machine's disks/)
  expect(clause).not.toMatch(/binds before a pod is scheduled/)
})

it("resolution follows the recipe's preference, then the cluster default", () => {
  const classes = [
    toStorageClassFact(CODEMOWERS_POSTGRES)!,
    toStorageClassFact({
      metadata: { name: 'gp3', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } },
      provisioner: 'ebs.csi.aws.com'
    })!
  ]

  expect(resolveStorageClass(classes, ['postgres'])?.name).toBe('postgres')
  // Preference misses entirely -> the cluster default, not the first class.
  expect(resolveStorageClass(classes, ['mysql'])?.name).toBe('gp3')
  // An explicit user choice wins over the preference list.
  expect(resolveStorageClass(classes, ['postgres'], 'gp3')?.name).toBe('gp3')
  // A user naming a class this cluster does not have must block, not fall back.
  expect(resolveStorageClass(classes, ['postgres'], 'nope')).toBe(null)
})

it('no preference match and no default is a blocker, not a guess', () => {
  const classes = [toStorageClassFact(CODEMOWERS_POSTGRES)!]

  expect(resolveStorageClass(classes, ['mysql'])).toBe(null)
})

it('the minikube default class is node-local, not unrecognised', () => {
  // Captured from a real minikube: this is what a developer sees locally, so
  // it must not read as "we cannot tell".
  const fact = toStorageClassFact({
    metadata: { name: 'standard', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } },
    provisioner: 'k8s.io/minikube-hostpath'
  })

  expect(fact?.topology).toBe('node-local')
  expect(fact?.replicaSafe).toBe(false)
  expect(fact?.implies ?? '').toMatch(/one machine's disks/)
})

it("derives the same fact from this server's catalog shape", () => {
  const fact = storageFactFromCatalog({
    name: 'postgres',
    provisioner: 'zfs.csi.openebs.io',
    reclaimPolicy: 'Retain',
    volumeBindingMode: null,
    allowVolumeExpansion: true,
    isDefault: true
  })

  expect(fact).toEqual({ ...toStorageClassFact(CODEMOWERS_POSTGRES), isDefault: true })
  expect(
    storageFactFromCatalog({
      name: 'x',
      provisioner: null,
      reclaimPolicy: null,
      volumeBindingMode: null,
      allowVolumeExpansion: false,
      isDefault: false
    })
  ).toBe(null)
})
