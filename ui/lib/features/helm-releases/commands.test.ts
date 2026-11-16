import assert from "node:assert/strict"
import test from "node:test"
import { uninstallCommand } from "./commands.ts"

const connection = {key:"key",name:"cluster",status:"available",aliases:[{name:"cluster/system",namespace:"kube-system"},{name:"cluster/app",namespace:"app"}]}
test("Rancher-managed releases delete the declaration in its actual namespace", () => {
  const command = uninstallCommand({name:"audit",namespace:"app",helmChartRef:"kube-system/audit"},connection)!
  assert.equal(command.target,"Rancher HelmChart")
  assert.equal(command.command,"kubectl delete --context 'cluster/system' helmchart.helm.cattle.io 'audit' --ignore-not-found")
})
test("ordinary releases use Helm with the explicit context and release namespace", () => {
  assert.equal(uninstallCommand({name:"audit",namespace:"app"},connection)?.command,"helm uninstall 'audit' --kube-context 'cluster/app' --namespace 'app' --ignore-not-found")
  assert.equal(uninstallCommand({name:"audit",namespace:"other"},connection)?.command,"helm uninstall 'audit' --kube-context 'cluster' --namespace 'other' --ignore-not-found")
})
