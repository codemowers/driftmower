import assert from "node:assert/strict"
import { test } from "node:test"
import { priorityClassName, runtimeChips } from "./pod-security.ts"
import type { ClusterResource } from "./cluster-state.ts"

const pod = (security: ClusterResource["security"]): ClusterResource =>
  ({ uid: "u", kind: "Pod", name: "p", namespace: "n", security })

test("the least isolated Pod decides the isolation chip", () => {
  assert.deepEqual(runtimeChips([pod({ isolationRank: 4, sandboxed: true, user: "image" }), pod({ isolationRank: 3, sandboxed: false, user: "nonroot" })]).map(c => c.label), ["rootless 1/2"])
  assert.deepEqual(runtimeChips([pod({ isolationRank: 2, sandboxed: false, user: "image", userNamespace: true })]).map(c => c.label), ["user namespace"])
  assert.deepEqual(runtimeChips([pod({ isolationRank: 1, sandboxed: false, user: "image" })]).map(c => c.label), ["may run as root"])
  assert.deepEqual(runtimeChips([pod({ isolationRank: 4, sandboxed: true, user: "root" })]).map(c => c.label), ["kata"])
})

test("root, privileges and runtimes are flagged", () => {
  const labels = runtimeChips([
    pod({ isolationRank: 0, sandboxed: false, runtimeClassName: "gvisor", user: "root", privileged: ["app"], hostNamespaces: ["hostNetwork"], addedCapabilities: ["NET_ADMIN"] }),
    pod({ isolationRank: 4, sandboxed: true, runtimeClassName: "kata", user: "nonroot" }),
  ]).map(c => c.label)
  assert.deepEqual(labels, ["root 1/2", "privileged", "hostNetwork", "+NET_ADMIN", "gvisor"])
})

test("priority colours follow the value", () => {
  assert.match(priorityClassName(2_000_000_000), /major/)
  assert.match(priorityClassName(100_000_000), /patch/)
  assert.match(priorityClassName(1000), /ok/)
  assert.match(priorityClassName(-1000), /gray/)
})

test("Kata guest privileges do not produce host warning badges",()=>{
 assert.deepEqual(runtimeChips([pod({isolationRank:4,sandboxed:true,user:"root",privileged:["app"],addedCapabilities:["SYS_ADMIN"],hostNamespaces:["hostNetwork"]})]).map(c=>c.label),["kata","hostNetwork"])
})
