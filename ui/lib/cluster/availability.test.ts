import assert from "node:assert/strict"
import { test } from "node:test"
import { availabilityChip, type PodSpread } from "./availability.ts"
import type { ClusterResource } from "./cluster-state.ts"

const pod = (nodeName: string, spread: PodSpread[] = []): ClusterResource =>
  ({ uid: nodeName, kind: "Pod", name: nodeName, namespace: "n", nodeName, spread })

test("one replica is not highly available", () => {
  assert.equal(availabilityChip([pod("a")])?.label, "single replica")
})

test("replicas without spread rules are flagged by placement", () => {
  assert.equal(availabilityChip([pod("a"), pod("a")])?.label, "replicas on one node")
  assert.equal(availabilityChip([pod("a"), pod("b")])?.label, "replicas unspread")
})

test("spread rules name their topology keys", () => {
  const zone: PodSpread = { kind: "topologySpreadConstraint", topologyKey: "topology.kubernetes.io/zone", hard: true }
  const host: PodSpread = { kind: "podAntiAffinity", topologyKey: "kubernetes.io/hostname", hard: false }
  const chip = availabilityChip([pod("a", [zone, host]), pod("b", [zone, host])])!
  assert.equal(chip.label, "HA by zone, node")
  assert.match(chip.title!, /Topology spread by topology.kubernetes.io\/zone \(required\)/)
  assert.match(chip.className, /ok/)
  assert.match(availabilityChip([pod("a", [host]), pod("b", [host])])!.className, /patch/)
})
