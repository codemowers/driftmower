import assert from "node:assert/strict"
import test from "node:test"
import { resourceCommands } from "./resource-commands.ts"

const connection = { key: "cluster", name: "cluster.example.test", status: "available" }
test("CRD commands qualify the API group without guessing a plural", () => {
  const commands = resourceCommands({ kind: "Cluster", apiVersion: "postgresql.cnpg.io/v1", namespace: "demo", name: "lolcatz-database" }, connection).flat()
  assert.equal(commands.find(c => c.label === "delete")?.value, "kubectl delete --context cluster.example.test --namespace demo cluster.postgresql.cnpg.io lolcatz-database")
  assert.equal(commands.find(c => c.label === "events")?.value, "kubectl events --context cluster.example.test --namespace demo --for cluster.postgresql.cnpg.io/lolcatz-database")
  assert.ok(commands.every(c => !c.value.includes("clusterss")))
})
test("Pod commands use namespace aliases and deduplicate TCP forwards", () => {
  const commands = resourceCommands({ kind: "Pod", namespace: "demo", name: "web-0", ports: [{port: 8080, protocol: "TCP"}, {port: 8080, protocol: "TCP"}, {port: 53, protocol: "UDP"}] }, { ...connection, aliases: [{ name: "cluster/demo", namespace: "demo" }] }).flat()
  assert.equal(commands.find(c => c.label === "logs")?.value, "kubectl logs --context cluster/demo web-0 --all-containers=true")
  assert.equal(commands.filter(c => c.label.startsWith("forward")).length, 1)
  assert.equal(commands.find(c => c.label === "forward 8080")?.value, "kubectl port-forward --context cluster/demo pod/web-0 8080:8080")
})
test("missing local metadata retains an explicit context placeholder", () => {
  const commands = resourceCommands({ kind: "Deployment", apiVersion: "apps/v1", namespace: "demo", name: "web" }).flat()
  assert.equal(commands.find(c => c.label === "restart")?.value, "kubectl rollout restart --context '<context>' --namespace demo deployment.apps web")
})
