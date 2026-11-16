import assert from "node:assert/strict"
import test from "node:test"
import { enrichSnapshot, referenceKeys } from "./enrich.ts"
import type { DashboardSnapshot } from "../../../browser/snapshot"

test("Docker Hub aliases match immutable digests before tags", () => {
  assert.deepEqual(referenceKeys("nginx"), ["docker.io/library/nginx:latest"])
  assert.deepEqual(referenceKeys("registry-1.docker.io/library/nginx:1.2@sha256:abc"), ["docker.io/library/nginx@sha256:abc", "docker.io/library/nginx:1.2"])
})

test("direct crawler summaries enrich shared views without replacing an unknown running digest with tag findings", () => {
  const root = { uid: "deploy", kind: "Deployment", name: "web", namespace: "team", groupKey: "Deployment/team/web" }
  const usage = (digest: string, finished = false) => ({ image: "nginx:latest", imageInfo: { registry: "docker.io", repository: "library/nginx", digest }, versionStatus: { statusType: "no_data" }, workloadRootInfo: root, releaseInfo: null, finished })
  const snapshot = { imageUsages: [usage("sha256:known"), usage("sha256:unknown"), usage("sha256:old", true)], drift: { workloadScores: {}, releaseScores: {} } } as unknown as DashboardSnapshot
  const status = (statusType: "minor_behind" | "major_behind") => ({ statusType, deployedTag: "1.0", latestTag: "1.1", majorDifference: 0, minorDifference: 1, patchDifference: 0 })
  enrichSnapshot(snapshot, [{ url: "https://github.com/nginx/nginx", deployed: [
    { version: "1.0", images: ["nginx:latest"], references: ["nginx@sha256:known"], versionStatus: status("minor_behind") },
    { version: "0.1", images: [], references: ["nginx@sha256:old"], versionStatus: status("major_behind") },
  ] }])
  assert.equal(snapshot.imageUsages[0].versionStatus.statusType, "minor_behind")
  assert.equal(snapshot.imageUsages[1].versionStatus.statusType, "no_data")
  assert.equal(snapshot.workloadGroups[root.groupKey][0], snapshot.imageUsages[0])
  assert.equal(snapshot.drift.normalizedScore, 2 / 3)
  assert.equal(snapshot.drift.workloadScores[root.groupKey].totalContainers, 2)
})
