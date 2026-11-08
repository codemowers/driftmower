import { test } from "node:test"
import assert from "node:assert/strict"
import { isDownscaled, isFinished } from "./workload-lifecycle.ts"

const summary = (succeeded: number, healthy = 0, failed = 0) => ({
  total: succeeded + healthy + failed,
  counts: { succeeded, healthy, failed, pending: 0, unknown: 0 },
  worst: { severity: "succeeded" as const, display: "Succeeded" }, restarts: 0,
})

test("completed standalone Pods and custom workloads are hidden, active/failed ones are not", () => {
  assert.equal(isFinished({pods:summary(1)}), true)
  assert.equal(isFinished({pods:summary(3)}), true)
  assert.equal(isFinished({pods:summary(1,1)}), false)
  assert.equal(isFinished({pods:summary(0,0,1)}), false)
  assert.equal(isFinished({pods:summary(0)}), false)
  assert.equal(isFinished({completed:true}), true)
})
test("downscaled requires explicit zero replicas and uses its own filter", () => {
  assert.equal(isDownscaled({pods:summary(0)}), false)
  assert.equal(isDownscaled({desiredReplicas:1,pods:summary(0)}), false)
  assert.equal(isDownscaled({desiredReplicas:0}), true)
  assert.equal(isFinished({desiredReplicas:0,pods:summary(1)}), false)
})
