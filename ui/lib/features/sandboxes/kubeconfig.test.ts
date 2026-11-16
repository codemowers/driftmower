import assert from "node:assert/strict"
import { test } from "node:test"

import { readContext } from "./kubeconfig.ts"

// Shaped like platform-manager's buildSandboxKubeconfig output.
function kubeconfig(context: string, cluster: string): string {
  return `apiVersion: v1
kind: Config
preferences: {}
clusters:
  - cluster:
      server: https://kube.example
    name: ${cluster}
contexts:
  - context:
      cluster: ${cluster}
      namespace: sb-78ac58-tyybid
      user: https://auth.example/
    name: ${context}
current-context: ${context}
users:
  - name: https://auth.example/
`
}

test("current context names, <cluster>/<namespace>: the cluster comes from the context entry", () => {
  const yaml = kubeconfig("bravo.example.com/sb-78ac58-tyybid", "bravo.example.com")

  assert.deepEqual(readContext(yaml, "78ac58-tyybid"), {
    context: "bravo.example.com/sb-78ac58-tyybid",
    clusterName: "bravo.example.com"
  })
})

test("older <sandbox>.<cluster> context names still yield the cluster", () => {
  const yaml = kubeconfig("78ac58-tyybid.bravo.example.com", "bravo.example.com")

  assert.equal(readContext(yaml, "78ac58-tyybid").clusterName, "bravo.example.com")
})

test("the scratch file name never contains a path separator", () => {
  const yaml = kubeconfig("odd/ctx", "weird/cluster")

  assert.equal(readContext(yaml, "x").clusterName, "weird_cluster")
})
