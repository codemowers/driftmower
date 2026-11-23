import assert from "node:assert/strict"
import test from "node:test"
import { platformName, preferredTag } from "./types.ts"

test("hierarchy labels retain exact versions and platform variants", () => {
  assert.equal(preferredTag(["3.13-alpine", "3.13.5-alpine3.21", "alpine"]), "3.13.5-alpine3.21")
  assert.equal(preferredTag(["1.9.9-alpine", "1.10.1-alpine"]), "1.10.1-alpine")
  assert.equal(platformName({ os: "linux", architecture: "arm64", variant: "v8" }), "linux/arm64/v8")
  assert.equal(platformName({ os: "linux", architecture: "amd64", variant: "v3" }), "linux/amd64/v3")
})
