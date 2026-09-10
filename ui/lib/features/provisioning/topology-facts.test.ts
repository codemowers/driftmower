import assert from "node:assert/strict"
import { test } from "node:test"

import { detectControlPlaneLabel, distinctZones, isSchedulable, toTopologyFact, type RawNode } from "./topology-facts.ts"

const ready = { conditions: [{ type: "Ready", status: "True" }], allocatable: { cpu: "4", memory: "8Gi" } }

test("cordoned, not-ready and NoSchedule-tainted nodes cannot host a new instance", () => {
  assert.equal(isSchedulable({ status: ready }), true)
  assert.equal(isSchedulable({ spec: { unschedulable: true }, status: ready }), false)
  assert.equal(isSchedulable({ status: { conditions: [{ type: "Ready", status: "False" }] } }), false)
  assert.equal(isSchedulable({ spec: { taints: [{ key: "x", effect: "NoSchedule" }] }, status: ready }), false)
  // PreferNoSchedule is a hint, not a barrier.
  assert.equal(isSchedulable({ spec: { taints: [{ key: "x", effect: "PreferNoSchedule" }] }, status: ready }), true)
})

test("capacity is summed per zone, and only over schedulable nodes", () => {
  const nodes: RawNode[] = [
    { metadata: { labels: { "topology.kubernetes.io/zone": "eu-a" } }, status: ready },
    { metadata: { labels: { "topology.kubernetes.io/zone": "eu-a" } }, status: ready },
    { metadata: { labels: { "topology.kubernetes.io/zone": "eu-b" } }, status: ready },
    // Cordoned: must not inflate either the node count or the capacity.
    { metadata: { labels: { "topology.kubernetes.io/zone": "eu-b" } }, spec: { unschedulable: true }, status: ready },
  ]
  const topology = toTopologyFact(nodes)

  assert.equal(topology.schedulableNodes, 3)
  assert.deepEqual(topology.zones.map(z => [z.zone, z.nodes]), [["eu-a", 2], ["eu-b", 1]])
  assert.equal(topology.zones[0].allocatable.cpuMillis, 8000)
  assert.equal(topology.zones[0].allocatable.memoryBytes, 2 * 8 * 1024 ** 3)
})

test("an unzoned cluster reports zero usable zones, so spreading is decoration", () => {
  const topology = toTopologyFact([{ status: ready }, { status: ready }])
  assert.equal(topology.schedulableNodes, 2)
  assert.equal(distinctZones(topology), 0)
  assert.equal(topology.zones[0].zone, "(no zone label)")
})

test("the control-plane label is derived, not configured", () => {
  // k3s / ee-lte-1
  assert.deepEqual(
    detectControlPlaneLabel([{ metadata: { labels: { "node-role.kubernetes.io/control-plane": "true" } } }]),
    { key: "node-role.kubernetes.io/control-plane", value: "true" },
  )
  // the AWS clusters
  assert.deepEqual(
    detectControlPlaneLabel([{ metadata: { labels: { "codemowers.cloud/node-role": "control-plane" } } }]),
    { key: "codemowers.cloud/node-role", value: "control-plane" },
  )
  assert.equal(detectControlPlaneLabel([{ metadata: { labels: { foo: "bar" } } }]), null)
})

test("a node carrying both labels reports the more specific one", () => {
  const label = detectControlPlaneLabel([
    { metadata: { labels: { "node-role.kubernetes.io/control-plane": "true", "codemowers.cloud/node-role": "control-plane" } } },
  ])
  assert.equal(label?.key, "codemowers.cloud/node-role")
})
