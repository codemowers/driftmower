import { test } from "node:test"
import assert from "node:assert/strict"
import { operatorResizeCommands } from "./operator-resize.ts"
import type { Claim } from "./types.ts"

const claim = (name: string, pod: string, size: string, canExpand = true) =>
  ({ name, namespace: "db", requestedStorage: size, provisionedStorage: size, canExpand, usedBy: [{ name: pod, uid: pod }] }) as unknown as Claim

test("renders CNPG data and WAL patches from the largest instance claim", () => {
  const claims = [claim("pg-1", "pg-1", "10Gi"), claim("pg-2", "pg-2", "12Gi"), claim("pg-1-wal", "pg-1", "2Gi"), claim("other", "x", "100Gi")]
  const out = operatorResizeCommands({ kind: "Cluster", apiVersion: "postgresql.cnpg.io/v1", namespace: "db", name: "pg" }, ["pg-1", "pg-2"], claims)
  assert.deepEqual(out.map(r => [r.label, r.current]), [["data", "12Gi"], ["WAL", "2Gi"]])
  assert.match(out[0].steps[2].command, /--namespace db cluster\.postgresql\.cnpg\.io pg --type=merge -p '\{"spec":\{"storage":\{"size":"24Gi"\}\}\}'$/)
  assert.equal(out[1].steps[0].size, "2458Mi")
})

test("ignores workloads without an adapter or claims", () => {
  assert.deepEqual(operatorResizeCommands({ kind: "Deployment", apiVersion: "apps/v1", namespace: "db", name: "x" }, ["x"], [claim("x", "x", "1Gi")]), [])
  assert.deepEqual(operatorResizeCommands({ kind: "Dragonfly", apiVersion: "dragonflydb.io/v1alpha1", namespace: "db", name: "c" }, ["c-0"], []), [])
})

test("patches the Redpanda chart storage size", () => {
  const out = operatorResizeCommands({ kind: "Redpanda", apiVersion: "cluster.redpanda.com/v1alpha2", namespace: "db", name: "rp" }, ["rp-0"], [claim("datadir-rp-0", "rp-0", "10Gi")])
  assert.equal(out[0].steps[1].size, "15Gi")
  assert.match(out[0].steps[1].command, /"clusterSpec":\{"storage":\{"persistentVolume":\{"size":"15Gi"\}\}\}/)
})
