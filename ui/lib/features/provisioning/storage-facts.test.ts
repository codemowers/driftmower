import assert from "node:assert/strict"
import { test } from "node:test"

import {
  classifyTopology,
  impliesClause,
  isReplicaSafe,
  resolveStorageClass,
  toStorageClassFact,
} from "./storage-facts.ts"

// The real thing, from codemowers-kube/kube-system-bootstrap/templates/zfs.yaml:
// reclaimPolicy Retain, expansion on, and no volumeBindingMode at all.
const CODEMOWERS_POSTGRES = {
  metadata: { name: "postgres" },
  provisioner: "zfs.csi.openebs.io",
  reclaimPolicy: "Retain",
  allowVolumeExpansion: true,
}

test("classifies the provisioners that actually appear on these clusters", () => {
  assert.equal(classifyTopology("zfs.csi.openebs.io"), "node-local")
  assert.equal(classifyTopology("topolvm.io"), "node-local")
  assert.equal(classifyTopology("ebs.csi.aws.com"), "zonal")
  assert.equal(classifyTopology("rook-ceph.rbd.csi.ceph.com"), "cluster-wide")
  assert.equal(classifyTopology("something.unknown.io"), "unknown")
})

test("only zonal and cluster-wide storage lets an operator move an instance", () => {
  assert.equal(isReplicaSafe("node-local"), false)
  // Unknown must not be treated as safe: that would turn a real blocker into silence.
  assert.equal(isReplicaSafe("unknown"), false)
  assert.equal(isReplicaSafe("zonal"), true)
  assert.equal(isReplicaSafe("cluster-wide"), true)
})

test("the codemowers postgres class parses with the API's defaults applied", () => {
  const fact = toStorageClassFact(CODEMOWERS_POSTGRES)
  assert.ok(fact)
  assert.equal(fact.topology, "node-local")
  assert.equal(fact.replicaSafe, false)
  assert.equal(fact.reclaimPolicy, "Retain")
  // volumeBindingMode is absent in the manifest; the API default is Immediate.
  assert.equal(fact.bindingMode, "Immediate")
  assert.equal(fact.isDefault, false)
})

test("reclaimPolicy defaults to Delete when the manifest omits it", () => {
  const fact = toStorageClassFact({ metadata: { name: "x" }, provisioner: "ebs.csi.aws.com" })
  assert.equal(fact?.reclaimPolicy, "Delete")
  assert.equal(fact?.allowExpansion, false)
})

test("a class without a name or provisioner is dropped rather than half-parsed", () => {
  assert.equal(toStorageClassFact({ metadata: { name: "x" } }), null)
  assert.equal(toStorageClassFact({ provisioner: "ebs.csi.aws.com" }), null)
})

test("the default-class annotation is read", () => {
  const fact = toStorageClassFact({
    metadata: { name: "gp3", annotations: { "storageclass.kubernetes.io/is-default-class": "true" } },
    provisioner: "ebs.csi.aws.com",
  })
  assert.equal(fact?.isDefault, true)
})

test("implies names every consequence that bites, including the Immediate trap", () => {
  const clause = toStorageClassFact(CODEMOWERS_POSTGRES)!.implies
  assert.match(clause, /one machine's disks/)
  assert.match(clause, /keeps the data after you delete/)
  assert.match(clause, /binds before a pod is scheduled/)
})

test("WaitForFirstConsumer suppresses the binding warning but not the pinning one", () => {
  const clause = impliesClause({
    topology: "node-local",
    reclaimPolicy: "Delete",
    allowExpansion: true,
    bindingMode: "WaitForFirstConsumer",
  })
  assert.match(clause, /one machine's disks/)
  assert.doesNotMatch(clause, /binds before a pod is scheduled/)
})

test("resolution follows the recipe's preference, then the cluster default", () => {
  const classes = [
    toStorageClassFact(CODEMOWERS_POSTGRES)!,
    toStorageClassFact({
      metadata: { name: "gp3", annotations: { "storageclass.kubernetes.io/is-default-class": "true" } },
      provisioner: "ebs.csi.aws.com",
    })!,
  ]

  assert.equal(resolveStorageClass(classes, ["postgres"])?.name, "postgres")
  // Preference misses entirely -> the cluster default, not the first class.
  assert.equal(resolveStorageClass(classes, ["mysql"])?.name, "gp3")
  // An explicit user choice wins over the preference list.
  assert.equal(resolveStorageClass(classes, ["postgres"], "gp3")?.name, "gp3")
  // A user naming a class this cluster does not have must block, not fall back.
  assert.equal(resolveStorageClass(classes, ["postgres"], "nope"), null)
})

test("no preference match and no default is a blocker, not a guess", () => {
  const classes = [toStorageClassFact(CODEMOWERS_POSTGRES)!]
  assert.equal(resolveStorageClass(classes, ["mysql"]), null)
})

test("the minikube default class is node-local, not unrecognised", () => {
  // Captured from a real minikube: this is what a developer sees locally, so
  // it must not read as "we cannot tell".
  const fact = toStorageClassFact({
    metadata: { name: "standard", annotations: { "storageclass.kubernetes.io/is-default-class": "true" } },
    provisioner: "k8s.io/minikube-hostpath",
  })
  assert.equal(fact?.topology, "node-local")
  assert.equal(fact?.replicaSafe, false)
  assert.match(fact?.implies ?? "", /one machine's disks/)
})
