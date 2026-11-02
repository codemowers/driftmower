import assert from "node:assert/strict"
import { test } from "node:test"

import { isPlatformHost, ownApps } from "./ownership.ts"
import type { ApplicationEntry } from "./types.ts"

const SUFFIX = "ee-lte-1.codemowers.io"
const MINE = ["a1b2c3-demo"]

const app = (name: string, url: string): ApplicationEntry => ({
  key: url,
  name,
  url,
  namespace: null,
  groups: [],
  description: null,
})

test("the platform's own monitoring hosts are not the sandbox's", () => {
  for (const host of ["thanos", "prometheus", "alertmanager", "grafana"]) {
    assert.equal(isPlatformHost(`${host}.${SUFFIX}`, MINE, SUFFIX), true, host)
  }
})

test("the sandbox's own hosts are its own, including its dedicated Prometheus", () => {
  assert.equal(isPlatformHost(`a1b2c3-demo.${SUFFIX}`, MINE, SUFFIX), false)
  assert.equal(isPlatformHost(`a1b2c3-demo-prom.${SUFFIX}`, MINE, SUFFIX), false)
  assert.equal(isPlatformHost(`a1b2c3-demo-api.${SUFFIX}`, MINE, SUFFIX), false)
})

test("a second sandbox's hosts count as the caller's when they own both", () => {
  const two = ["a1b2c3-demo", "z9y8x7-other"]
  assert.equal(isPlatformHost(`z9y8x7-other-prom.${SUFFIX}`, two, SUFFIX), false)
  // ...but not when they only own the first.
  assert.equal(isPlatformHost(`z9y8x7-other-prom.${SUFFIX}`, MINE, SUFFIX), true)
})

// The rule answers "who owns this hostname", which is only a question about
// hostnames on this cluster. Everything else passmower advertises stays.
test("apps hosted off the cluster domain are left alone", () => {
  assert.equal(isPlatformHost("github.com", MINE, SUFFIX), false)
  assert.equal(isPlatformHost("grafana.example.com", MINE, SUFFIX), false)
  assert.equal(isPlatformHost(`thanos.ee-west-1.codemowers.io`, MINE, SUFFIX), false)
})

test("the launcher keeps the sandbox's apps and drops the platform's", () => {
  const kept = ownApps(
    [
      app("Thanos", `https://thanos.${SUFFIX}`),
      app("Prometheus", `https://prometheus.${SUFFIX}`),
      app("My Prometheus", `https://a1b2c3-demo-prom.${SUFFIX}`),
      app("My App", `https://a1b2c3-demo.${SUFFIX}`),
      app("GitHub", "https://github.com/codemowers"),
    ],
    MINE,
    SUFFIX,
  )

  assert.deepEqual(kept.map(e => e.name), ["My Prometheus", "My App", "GitHub"])
})

// Emptying someone's launcher is a worse failure than the stale tile this
// removes, so an unknown suffix hides nothing.
test("nothing is hidden when the domain suffix is unknown", () => {
  const all = [app("Thanos", `https://thanos.${SUFFIX}`)]
  assert.deepEqual(ownApps(all, MINE, null), all)
})

test("an unparseable url is left in place rather than attributed", () => {
  const odd = [app("Broken", "not a url")]
  assert.deepEqual(ownApps(odd, MINE, SUFFIX), odd)
})

// A sandbox user with no sandboxes yet would otherwise have every cluster host
// hidden; that is the correct answer -- none of them are theirs.
test("a caller with no sandboxes owns no cluster hostname", () => {
  assert.equal(isPlatformHost(`a1b2c3-demo-prom.${SUFFIX}`, [], SUFFIX), true)
})
