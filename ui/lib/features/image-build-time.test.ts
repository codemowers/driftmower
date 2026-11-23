import assert from "node:assert/strict"
import test from "node:test"
import { imageBuildTime } from "./image-build-time.ts"

const config = "2018-09-28T17:05:09Z"
const file = "2018-09-28T17:05:08Z"
const artifacts = [{ digest: "sha256:backend", configCreated: config, analysis: { latestFileModifiedAt: file } }]

test("created label takes precedence over config and file observations", () => {
  const result = imageBuildTime("2020-01-01T00:00:00Z", artifacts)
  assert.equal(result.primary?.source, "label")
  assert.equal(result.primary?.timestamp, "2020-01-01T00:00:00Z")
  assert.deepEqual(result.facts.map(f => f.source), ["label", "config", "file"])
  assert.equal(result.conflict, true)
})

test("backend without labels uses its config timestamp and tolerates one-second difference", () => {
  const result = imageBuildTime(undefined, artifacts)
  assert.equal(result.primary?.source, "config")
  assert.equal(result.primary?.timestamp, config)
  assert.equal(result.conflict, false)
})

test("invalid declared times fall back to observed file time without fabricating metadata", () => {
  const result = imageBuildTime("invalid", [{ digest: "d", configCreated: "", analysis: { latestFileModifiedAt: file } }])
  assert.equal(result.primary?.source, "file")
  assert.equal(result.primary?.timestamp, file)
  assert.equal(result.facts.length, 1)
  assert.equal(imageBuildTime(undefined).primary, undefined)
  assert.equal(imageBuildTime(undefined, [{ digest: "d", configCreated: "invalid" }]).primary, undefined)
})

test("one hour is inclusive, compares instants across time zones and includes discrepancies between secondaries", () => {
  assert.equal(imageBuildTime("2018-09-28T18:05:08Z", artifacts).conflict, true)
  assert.equal(imageBuildTime("2018-09-28T18:05:07Z", artifacts).conflict, false)
  assert.equal(imageBuildTime("2018-09-28T20:05:09+03:00", artifacts).conflict, false)
  assert.equal(imageBuildTime("2018-09-28T17:35:09Z", [{ digest: "d", configCreated: config, analysis: { latestFileModifiedAt: "2018-09-28T18:35:09Z" } }]).conflict, true)
})

test("multiple platforms retain evidence and select deterministic config/file fallbacks", () => {
  const platforms = [...artifacts, { digest: "sha256:other", configCreated: "2019-01-01T00:00:00Z", analysis: { latestFileModifiedAt: "2019-01-01T00:00:00Z" } }]
  const result = imageBuildTime(undefined, platforms)
  assert.equal(result.primary?.timestamp, config)
  assert.equal(result.primary?.digest, "sha256:backend")
  assert.equal(result.conflict, true)
  assert.deepEqual(imageBuildTime(undefined, [...platforms].reverse()), result)
  assert.equal(imageBuildTime(undefined, platforms.map(p => ({ ...p, configCreated: undefined }))).primary?.timestamp, "2019-01-01T00:00:00Z")
})
