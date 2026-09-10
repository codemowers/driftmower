import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import {
  fromAggregated,
  fromResourceLists,
  groupVersionsOf,
  isAggregated,
  negotiateVersion,
  servesGroup,
  type AggregatedList,
  type GroupList,
} from "./api-surface.ts"

// Captured from a real apiserver (minikube v1.35.1) and trimmed to the fields
// the parser reads, so a shape change upstream fails here rather than in prod.
const aggregated = JSON.parse(
  readFileSync(new URL("./__fixtures__/aggregated-discovery.json", import.meta.url), "utf8"),
) as AggregatedList

test("detects the aggregated shape and rejects the legacy one", () => {
  assert.equal(isAggregated(aggregated), true)
  assert.equal(isAggregated({ groups: [{ name: "apps", versions: [{ version: "v1" }] }] }), false)
})

test("parses kinds, plurals and scope out of aggregated discovery", () => {
  const surface = fromAggregated(aggregated)

  assert.deepEqual(surface.byKind.get("apps/v1/Deployment"), {
    group: "apps",
    version: "v1",
    kind: "Deployment",
    plural: "deployments",
    namespaced: true,
  })
  assert.deepEqual(surface.byKind.get("monitoring.coreos.com/v1/PodMonitor"), {
    group: "monitoring.coreos.com",
    version: "v1",
    kind: "PodMonitor",
    plural: "podmonitors",
    namespaced: true,
  })
  assert.equal(surface.aggregated, true)
  assert.equal(servesGroup(surface, "monitoring.coreos.com"), true)
  assert.equal(servesGroup(surface, "postgresql.cnpg.io"), false)
})

test("legacy parsing drops subresources, which are not creatable", () => {
  const surface = fromResourceLists([
    {
      group: "monitoring.coreos.com",
      version: "v1",
      list: {
        resources: [
          { name: "podmonitors", kind: "PodMonitor", namespaced: true },
          { name: "podmonitors/status", kind: "PodMonitor", namespaced: true },
        ],
      },
    },
  ])

  assert.equal(surface.byKind.size, 1)
  assert.equal(surface.byKind.get("monitoring.coreos.com/v1/PodMonitor")?.plural, "podmonitors")
  assert.equal(surface.aggregated, false)
})

test("legacy parsing tolerates a group that vanished between calls", () => {
  const surface = fromResourceLists([{ group: "gone.example.com", version: "v1", list: null }])
  assert.equal(surface.byKind.size, 0)
  // The version is still recorded: the group exists, we just could not list it.
  assert.deepEqual(surface.versionsByGroup.get("gone.example.com"), ["v1"])
})

test("groupVersionsOf flattens every served version, not just the preferred one", () => {
  const groups: GroupList = {
    groups: [{ name: "apps.emqx.io", versions: [{ version: "v2beta1" }, { version: "v2alpha1" }] }],
  }
  assert.deepEqual(groupVersionsOf(groups), [
    { group: "apps.emqx.io", version: "v2beta1" },
    { group: "apps.emqx.io", version: "v2alpha1" },
  ])
})

test("version negotiation prefers the recipe's order over the cluster's", () => {
  const surface = fromResourceLists([
    { group: "apps.emqx.io", version: "v2alpha1", list: { resources: [{ name: "emqxes", kind: "EMQX", namespaced: true }] } },
    { group: "apps.emqx.io", version: "v2beta1", list: { resources: [{ name: "emqxes", kind: "EMQX", namespaced: true }] } },
  ])

  // The recipe wants v2beta1 first, and the cluster serves both.
  assert.equal(negotiateVersion(surface, "apps.emqx.io", "EMQX", ["v2beta1", "v2alpha1"])?.version, "v2beta1")
  // Only the fallback is supported by the recipe.
  assert.equal(negotiateVersion(surface, "apps.emqx.io", "EMQX", ["v2alpha1"])?.version, "v2alpha1")
})

test("version negotiation returns null when the cluster serves only unknown versions", () => {
  const surface = fromResourceLists([
    { group: "apps.emqx.io", version: "v2alpha2", list: { resources: [{ name: "emqxes", kind: "EMQX", namespaced: true }] } },
  ])
  // This is the fail-safe: the planner must block, not emit a rejected manifest.
  assert.equal(negotiateVersion(surface, "apps.emqx.io", "EMQX", ["v2beta1", "v2alpha1"]), null)
})
