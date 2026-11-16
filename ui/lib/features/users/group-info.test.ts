import assert from "node:assert/strict"
import { test } from "node:test"
import { groupsFromUsers, parseGroup } from "./group-info.ts"
import type { OIDCUser } from "./types.ts"

const user = (name: string, groups: string[]): OIDCUser => ({ name, namespace: "passmower", emails: [], groups, passkeyCount: 0 })

test("GitHub-derived groups link to their organization team page", () => {
  assert.deepEqual(parseGroup("github.com:codemowers:admins"), {
    id: "github.com:codemowers:admins", source: "github.com", name: "codemowers:admins",
    github: { org: "codemowers", team: "admins", url: "https://github.com/orgs/codemowers/teams/admins" },
  })
})

test("other groups keep their prefix as source and get no team link", () => {
  assert.deepEqual(parseGroup("passmower:admins"), { id: "passmower:admins", source: "passmower", name: "admins" })
  assert.deepEqual(parseGroup("github.com:codemowers"), { id: "github.com:codemowers", source: "github.com", name: "codemowers" })
})

test("memberships are grouped by group and sorted by source then name", () => {
  const groups = groupsFromUsers([user("a", ["passmower:admins", "github.com:codemowers:admins"]), user("b", ["github.com:codemowers:admins"])])
  assert.deepEqual(groups.map(g => [g.id, g.members.map(m => m.name)]), [
    ["github.com:codemowers:admins", ["a", "b"]],
    ["passmower:admins", ["a"]],
  ])
})
