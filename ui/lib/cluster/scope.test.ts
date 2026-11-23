import { test } from "node:test"
import assert from "node:assert/strict"
import { aggregateIssues, scopeUsages } from "./scope.ts"
import type { ClusterResource } from "./cluster-state"
import type { ImageUsage } from "./reports"

const usage = (namespace: string, podName: string, uid: string, finished = false) =>
  ({ namespace, podName, finished, image: "x", workloadRootInfo: { uid } }) as unknown as ImageUsage

test("scopes usages by namespace, workload and Pod", () => {
  const usages = [usage("a", "p1", "w1"), usage("a", "p2", "w1"), usage("b", "p3", "w2"), usage("b", "p4", "w2", true)]
  assert.equal(scopeUsages(usages, { kind: "cluster" }).length, 3)
  assert.equal(scopeUsages(usages, { kind: "namespace", namespace: "b" }).length, 1)
  assert.equal(scopeUsages(usages, { kind: "workload", uid: "w1" }).length, 2)
  assert.equal(scopeUsages(usages, { kind: "pod", namespace: "a", name: "p1" }).length, 1)
  assert.equal(scopeUsages(usages, { kind: "pod", namespace: "a", name: "gone", workloadUid: "w1" }).length, 2)
})

test("counts each Pod once per issue", () => {
  const issue = { code: "crash", severity: "critical" as const, message: "CrashLoopBackOff" }
  const pods = [{ uid: "1", kind: "Pod", issues: [issue] }, { uid: "2", kind: "Pod", issues: [issue] }, { uid: "1", kind: "Pod", issues: [issue] }] as ClusterResource[]
  assert.deepEqual(aggregateIssues(pods), [{ ...issue, podCount: 2 }])
})
