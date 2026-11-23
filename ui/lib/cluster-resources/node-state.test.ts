import test from "node:test"
import assert from "node:assert/strict"
import { nodeState } from "./node-state.ts"
import type { NodeDrift } from "./types.ts"

const ready = { readiness: "Ready", schedulable: true, pressure: { memory: false, disk: false, pid: false } } satisfies Pick<NodeDrift, "readiness" | "schedulable" | "pressure">

test("node edge color reflects readiness and additional active conditions", () => {
  assert.equal(nodeState(ready).border, "border-l-status-ok")
  assert.equal(nodeState({ ...ready, schedulable: false }).border, "border-l-status-patch")
  for (const pressure of ["memory", "disk", "pid"] as const) {
    assert.equal(nodeState({ ...ready, pressure: { ...ready.pressure, [pressure]: true } }).border, "border-l-status-patch")
  }
  assert.equal(nodeState({ ...ready, conditions: ["NetworkUnavailable"] }).border, "border-l-status-patch")
  assert.equal(nodeState({ ...ready, conditions: ["OutOfDisk"] }).border, "border-l-status-patch")
  assert.equal(nodeState({ ...ready, readiness: "NotReady", schedulable: false }).border, "border-l-status-major")
  assert.equal(nodeState({ ...ready, readiness: "Unknown" }).border, "border-l-gray-300")
})

test("positive and unclassified conditions remain visible without implying a fault", () => {
  for (const condition of ["EtcdIsVoter", "CustomPositiveCondition"]) {
    const state = nodeState({ ...ready, conditions: [condition] })
    assert.equal(state.border, "border-l-status-ok")
    assert.equal(state.label, `Ready, ${condition}`)
  }
  assert.equal(nodeState({ ...ready, conditions: ["EtcdIsVoter", "DiskPressure"] }).border, "border-l-status-patch")
  assert.equal(nodeState({ ...ready, conditions: ["EtcdIsVoter"], schedulable: false }).border, "border-l-status-patch")
  assert.equal(nodeState({ ...ready, conditions: ["EtcdIsVoter"], readiness: "NotReady" }).border, "border-l-status-major")
})

test("accessible state keeps additional conditions without repeating pressure", () => {
  const state = nodeState({ ...ready, schedulable: false, pressure: { ...ready.pressure, memory: true }, conditions: ["MemoryPressure", "NetworkUnavailable"] })
  assert.equal(state.label, "Ready, SchedulingDisabled, MemoryPressure, NetworkUnavailable")
})
