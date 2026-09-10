import assert from "node:assert/strict"
import { test } from "node:test"

import { bindingAppliesTo, mayCreate, ruleCovers, rulesCover, type Caller, type RawRoleBinding } from "./authz-heuristic.ts"

const CALLER: Caller = {
  sub: "erki",
  groups: ["github.com:codemowers:admins"],
  usernamePrefixes: ["https://auth.ee-lte-1.codemowers.io/#", ""],
}

// What sandbox-stack actually renders: owners bound to the built-in admin role.
const SANDBOX_OWNERS: RawRoleBinding = {
  metadata: { name: "sandbox-owners" },
  roleRef: { kind: "ClusterRole", name: "admin" },
  subjects: [
    { kind: "Group", apiGroup: "rbac.authorization.k8s.io", name: "github.com:codemowers:admins" },
    { kind: "User", apiGroup: "rbac.authorization.k8s.io", name: "https://auth.ee-lte-1.codemowers.io/#erki" },
  ],
}

// A faithful excerpt: the real admin.rules on a stock cluster covers core and
// apps but no CRD group. Verified against a live cluster.
const ADMIN_RULES = [
  { apiGroups: [""], resources: ["pods", "services", "secrets"], verbs: ["*"] },
  { apiGroups: ["apps"], resources: ["deployments", "statefulsets"], verbs: ["*"] },
  { apiGroups: ["networking.k8s.io"], resources: ["networkpolicies"], verbs: ["*"] },
]

test("wildcards in either position count as coverage", () => {
  assert.equal(ruleCovers({ apiGroups: ["*"], resources: ["*"], verbs: ["*"] }, "postgresql.cnpg.io", "clusters", "create"), true)
  assert.equal(ruleCovers({ apiGroups: ["postgresql.cnpg.io"], resources: ["clusters"], verbs: ["create"] }, "postgresql.cnpg.io", "clusters", "create"), true)
  // A rule for the right group but the wrong resource must not count.
  assert.equal(ruleCovers({ apiGroups: ["postgresql.cnpg.io"], resources: ["backups"], verbs: ["*"] }, "postgresql.cnpg.io", "clusters", "create"), false)
  // Nor the right resource with only read verbs.
  assert.equal(ruleCovers({ apiGroups: ["postgresql.cnpg.io"], resources: ["clusters"], verbs: ["get", "list"] }, "postgresql.cnpg.io", "clusters", "create"), false)
})

test("core-group rules use the empty string, not a missing field", () => {
  assert.equal(rulesCover(ADMIN_RULES, "", "secrets", "create"), true)
  assert.equal(rulesCover(ADMIN_RULES, "apps", "deployments", "create"), true)
})

test("group and prefixed-user subjects both match the caller", () => {
  assert.equal(bindingAppliesTo(SANDBOX_OWNERS, CALLER), true)
  assert.equal(bindingAppliesTo(SANDBOX_OWNERS, { ...CALLER, sub: "someone-else", groups: [] }), false)
  // A ServiceAccount subject is never the interactive caller.
  assert.equal(
    bindingAppliesTo({ subjects: [{ kind: "ServiceAccount", name: "erki" }], roleRef: { name: "admin" } }, CALLER),
    false,
  )
})

test("an unprefixed User subject still matches, since the prefix is per cluster", () => {
  const bare: RawRoleBinding = { roleRef: { name: "admin" }, subjects: [{ kind: "User", name: "erki" }] }
  assert.equal(bindingAppliesTo(bare, CALLER), true)
})

test("this is the finding: namespace-admin does not reach an operator CRD", () => {
  const verdict = mayCreate([SANDBOX_OWNERS], [{ name: "admin", rules: ADMIN_RULES }], CALLER, {
    group: "postgresql.cnpg.io",
    plural: "clusters",
  })

  assert.equal(verdict.mayCreate, "likely-not")
  assert.match(verdict.reason, /aggregate-to-admin/)
  assert.match(verdict.reason, /403/)
})

test("an operator that does ship an aggregated rule reads as likely", () => {
  // What it looks like once the aggregation controller has flattened a
  // cnpg-cloudnative-pg-edit ClusterRole into admin.rules.
  const withCnpg = [...ADMIN_RULES, { apiGroups: ["postgresql.cnpg.io"], resources: ["clusters"], verbs: ["*"] }]
  const verdict = mayCreate([SANDBOX_OWNERS], [{ name: "admin", rules: withCnpg }], CALLER, {
    group: "postgresql.cnpg.io",
    plural: "clusters",
  })

  assert.equal(verdict.mayCreate, "likely")
  assert.match(verdict.reason, /sandbox-owners/)
})

test("no binding for this caller is unknown, not a denial", () => {
  const verdict = mayCreate([SANDBOX_OWNERS], [{ name: "admin", rules: ADMIN_RULES }], { ...CALLER, sub: "nobody", groups: [] }, {
    group: "postgresql.cnpg.io",
    plural: "clusters",
  })
  // Claiming "likely-not" here would be a lie: access can come from bindings
  // we are not permitted to see.
  assert.equal(verdict.mayCreate, "unknown")
  assert.match(verdict.reason, /can-i/)
})

test("a role we may not read is unknown, and says which role", () => {
  const custom: RawRoleBinding = {
    metadata: { name: "team-role" },
    roleRef: { kind: "ClusterRole", name: "team-custom" },
    subjects: [{ kind: "Group", name: "github.com:codemowers:admins" }],
  }
  const verdict = mayCreate([custom], [{ name: "admin", rules: ADMIN_RULES }], CALLER, {
    group: "postgresql.cnpg.io",
    plural: "clusters",
  })

  assert.equal(verdict.mayCreate, "unknown")
  assert.match(verdict.reason, /team-custom/)
})

test("one covering binding wins even when another does not cover", () => {
  const extra: RawRoleBinding = {
    metadata: { name: "db-admins" },
    roleRef: { kind: "ClusterRole", name: "cnpg-edit" },
    subjects: [{ kind: "Group", name: "github.com:codemowers:admins" }],
  }
  const verdict = mayCreate(
    [SANDBOX_OWNERS, extra],
    [
      { name: "admin", rules: ADMIN_RULES },
      { name: "cnpg-edit", rules: [{ apiGroups: ["postgresql.cnpg.io"], resources: ["clusters"], verbs: ["create"] }] },
    ],
    CALLER,
    { group: "postgresql.cnpg.io", plural: "clusters" },
  )

  assert.equal(verdict.mayCreate, "likely")
  assert.match(verdict.reason, /cnpg-edit/)
})

test("an admission denial outranks a role that would otherwise allow it", () => {
  // The correction: sandbox owners hold `admin`, which covers networkpolicies,
  // so RBAC alone says "likely" for something sandbox-egress-guard rejects.
  const netpolAdmin = [{ apiGroups: ["networking.k8s.io"], resources: ["networkpolicies"], verbs: ["*"] }]

  const rbacOnly = mayCreate([SANDBOX_OWNERS], [{ name: "admin", rules: netpolAdmin }], CALLER, {
    group: "networking.k8s.io",
    plural: "networkpolicies",
  })
  assert.equal(rbacOnly.mayCreate, "likely")

  const withAdmission = mayCreate(
    [SANDBOX_OWNERS],
    [{ name: "admin", rules: netpolAdmin }],
    CALLER,
    { group: "networking.k8s.io", plural: "networkpolicies" },
    [{ policy: "sandbox-egress-guard", messages: ["Sandbox users cannot create or update NetworkPolicies"] }],
  )

  assert.equal(withAdmission.mayCreate, "likely-not")
  assert.match(withAdmission.reason, /sandbox-egress-guard/)
  // The user must learn that fixing their role would not help.
  assert.match(withAdmission.reason, /overrides your role/)
  assert.match(withAdmission.reason, /platform access/)
})

test("no admission denial leaves the RBAC verdict untouched", () => {
  const verdict = mayCreate([SANDBOX_OWNERS], [{ name: "admin", rules: ADMIN_RULES }], CALLER, {
    group: "postgresql.cnpg.io",
    plural: "clusters",
  }, [])
  assert.equal(verdict.mayCreate, "likely-not")
  assert.match(verdict.reason, /aggregate-to-admin/)
})
