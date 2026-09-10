import assert from "node:assert/strict"
import { test } from "node:test"

import {
  denialsFor,
  toAdmissionFacts,
  type RawAdmissionBinding,
  type RawAdmissionPolicy,
} from "./admission-facts.ts"

// The real guards, from platform-manager/deploy/{egress,sandbox}-guard.yaml.
const EGRESS_GUARD: RawAdmissionPolicy = {
  metadata: { name: "sandbox-egress-guard" },
  spec: {
    failurePolicy: "Fail",
    matchConstraints: {
      resourceRules: [
        {
          apiGroups: ["networking.k8s.io"],
          apiVersions: ["v1"],
          operations: ["CREATE", "UPDATE", "DELETE"],
          resources: ["networkpolicies"],
        },
      ],
    },
    validations: [
      { message: "Sandbox users cannot create or update NetworkPolicies", reason: "Forbidden" },
    ],
  },
}

const INGRESS_GUARD: RawAdmissionPolicy = {
  metadata: { name: "sandbox-ingress-guard" },
  spec: {
    paramKind: { apiVersion: "v1", kind: "ConfigMap" },
    matchConstraints: {
      resourceRules: [
        { apiGroups: ["networking.k8s.io"], operations: ["CREATE", "UPDATE"], resources: ["ingresses"] },
        { apiGroups: ["traefik.io"], operations: ["CREATE", "UPDATE"], resources: ["ingressroutes"] },
      ],
    },
    validations: [
      {
        message: "Traefik IngressRoute resources are not available in sandboxes; use a\n  standard Ingress",
      },
      { message: "Ingress hosts in this sandbox must be <sandbox-id>.<domain> or" },
    ],
  },
}

const SANDBOX_SCOPE = { "codemowers.io/sandbox": "abc123-demo" }

function bindingFor(policyName: string, over: Partial<NonNullable<RawAdmissionBinding["spec"]>> = {}): RawAdmissionBinding {
  return {
    metadata: { name: `${policyName}-binding` },
    spec: {
      policyName,
      matchResources: { namespaceSelector: { matchLabels: { "codemowers.io/sandbox": "abc123-demo" } } },
      ...over,
    },
  }
}

test("a bound policy is enforced and keeps its own human message", () => {
  const [fact] = toAdmissionFacts([EGRESS_GUARD], [bindingFor("sandbox-egress-guard")])

  assert.equal(fact.name, "sandbox-egress-guard")
  assert.equal(fact.enforced, true)
  assert.deepEqual(fact.guards, [
    { group: "networking.k8s.io", resource: "networkpolicies", operations: ["CREATE", "UPDATE", "DELETE"] },
  ])
  assert.match(fact.messages[0], /cannot create or update NetworkPolicies/)
})

test("validationActions defaults to Deny when a binding omits it", () => {
  const [fact] = toAdmissionFacts([EGRESS_GUARD], [bindingFor("sandbox-egress-guard", { validationActions: undefined })])
  assert.equal(fact.enforced, true)
})

test("an Audit-only binding does not block, and says so", () => {
  const [fact] = toAdmissionFacts([EGRESS_GUARD], [bindingFor("sandbox-egress-guard", { validationActions: ["Audit"] })])
  assert.equal(fact.enforced, false)
  assert.match(fact.enforcement, /will not block/)
})

test("an unbound policy does nothing at all", () => {
  const [fact] = toAdmissionFacts([EGRESS_GUARD], [])
  assert.equal(fact.enforced, false)
  assert.match(fact.enforcement, /no binding/)
})

test("messages are whitespace-normalised, since YAML folds them across lines", () => {
  const [fact] = toAdmissionFacts([INGRESS_GUARD], [bindingFor("sandbox-ingress-guard")])
  assert.ok(fact.messages.some(m => m === "Traefik IngressRoute resources are not available in sandboxes; use a standard Ingress"))
})

test("the params ConfigMap is reported, so the caller knows to fetch it", () => {
  const [fact] = toAdmissionFacts(
    [INGRESS_GUARD],
    [bindingFor("sandbox-ingress-guard", { paramRef: { name: "sandbox-guard-params", namespace: "kube-system" } })],
  )
  assert.deepEqual(fact.paramRef, { name: "sandbox-guard-params", namespace: "kube-system" })
})

test("this is the correction: netpol creation is denied where RBAC would allow it", () => {
  const facts = toAdmissionFacts([EGRESS_GUARD], [bindingFor("sandbox-egress-guard")])

  const denials = denialsFor(facts, {
    group: "networking.k8s.io",
    resource: "networkpolicies",
    operation: "CREATE",
    namespaceLabels: SANDBOX_SCOPE,
  })

  assert.equal(denials.length, 1)
  assert.equal(denials[0].policy, "sandbox-egress-guard")
  assert.match(denials[0].message, /cannot create or update NetworkPolicies/)
})

test("a policy scoped to sandboxes does not apply to a namespace that is not one", () => {
  const facts = toAdmissionFacts([EGRESS_GUARD], [bindingFor("sandbox-egress-guard")])

  const denials = denialsFor(facts, {
    group: "networking.k8s.io",
    resource: "networkpolicies",
    operation: "CREATE",
    // A platform namespace carries no sandbox label.
    namespaceLabels: {},
  })

  assert.deepEqual(denials, [])
})

test("an unrelated resource is not swept up", () => {
  const facts = toAdmissionFacts([EGRESS_GUARD], [bindingFor("sandbox-egress-guard")])

  assert.deepEqual(
    denialsFor(facts, {
      group: "postgresql.cnpg.io",
      resource: "clusters",
      operation: "CREATE",
      namespaceLabels: SANDBOX_SCOPE,
    }),
    [],
  )
})

test("DELETE is distinguished from CREATE, since deleting leftovers stays allowed", () => {
  // The ingress guard only matches CREATE and UPDATE.
  const facts = toAdmissionFacts([INGRESS_GUARD], [bindingFor("sandbox-ingress-guard")])
  const check = { group: "networking.k8s.io", resource: "ingresses", namespaceLabels: SANDBOX_SCOPE } as const

  assert.equal(denialsFor(facts, { ...check, operation: "CREATE" }).length, 1)
  assert.equal(denialsFor(facts, { ...check, operation: "DELETE" }).length, 0)
})

test("a wildcard rule matches any group or resource it is written over", () => {
  const wildcard: RawAdmissionPolicy = {
    metadata: { name: "catch-all" },
    spec: { matchConstraints: { resourceRules: [{ apiGroups: ["*"], resources: ["*"], operations: ["*"] }] } },
  }
  const facts = toAdmissionFacts([wildcard], [bindingFor("catch-all")])

  assert.equal(
    denialsFor(facts, { group: "anything.io", resource: "widgets", operation: "UPDATE", namespaceLabels: SANDBOX_SCOPE }).length,
    1,
  )
})

test("enforced policies sort ahead of inert ones", () => {
  const facts = toAdmissionFacts(
    [INGRESS_GUARD, EGRESS_GUARD],
    [bindingFor("sandbox-egress-guard")],
  )
  assert.deepEqual(facts.map(f => [f.name, f.enforced]), [
    ["sandbox-egress-guard", true],
    ["sandbox-ingress-guard", false],
  ])
})
