import assert from "node:assert/strict"
import test from "node:test"
import { connectionForEndpoint, kubectlCommand, scopeActionCommand, type KubeconfigConnection } from "./contexts.ts"

const connection: KubeconfigConnection = { key: "oidc", name: "foo", status: "available", url: "https://mcp.example/mcp", aliases: [{ name: "foo" }, { name: "foo/bar", namespace: "bar" }] }
test("commands prefer configured namespace aliases and otherwise pin namespace", () => {
  assert.equal(kubectlCommand("get", connection, "bar"), "kubectl get --context foo/bar")
  assert.equal(kubectlCommand("patch", connection, "other"), "kubectl patch --context foo --namespace other")
  assert.equal(kubectlCommand("get", connection), "kubectl get --context foo")
  assert.equal(kubectlCommand("get", undefined, "bar"), "kubectl get --context '<context>' --namespace bar")
  assert.equal(scopeActionCommand("kubectl rollout restart -n bar deployment/app", connection), "kubectl rollout --context foo/bar restart deployment/app")
  assert.equal(scopeActionCommand("kubectl set image deployment/app web=example:v2 -n other", connection), "kubectl set --context foo --namespace other image deployment/app web=example:v2")
})
test("connections sharing an endpoint need an explicit authentication choice", () => {
  const admin = { ...connection, key: "certificate", name: "admin", certificate: true }
  assert.equal(connectionForEndpoint([connection, admin], connection.url!), undefined)
  assert.equal(connectionForEndpoint([connection, admin], connection.url!, "oidc"), connection)
  assert.equal(connectionForEndpoint([connection], connection.url!), connection)
})
