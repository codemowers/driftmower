import assert from "node:assert/strict"
import { test } from "node:test"
import { registeredApplications, otherHosts } from "./entries.ts"
import type { ApplicationEntry } from "./types.ts"

const app = (url: string, name = "agent"): ApplicationEntry => ({key: name + url, name, url, namespace: "apps", groups: [], description: null})

test("duplicate OIDC registrations with the same launch URL produce one tile", () => {
  assert.equal(registeredApplications([app("https://dashboard.example.com"), app("https://dashboard.example.com/", "old-client")]).length, 1)
  assert.equal(registeredApplications([app("https://dashboard.example.com/"), app("https://dashboard.example.com/ui")]).length, 2)
})

test("other hosts exclude registered hosts and collapse internal route paths", () => {
  const entries = [app("https://dashboard.example.com/api"), app("https://other.example.com/api"), app("https://other.example.com/"), app("https://solver.example.com/", "cm-acme-http-solver-abc")]
  assert.deepEqual(otherHosts(entries, [app("https://dashboard.example.com/")]).map(e => e.url), ["https://other.example.com/"])
})
