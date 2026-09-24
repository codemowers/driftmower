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
    variables: [
      { name: "sandbox", expression: "namespaceObject.metadata.labels['codemowers.io/sandbox']" },
    ],
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
    variables: [
      { name: "sandbox", expression: "namespaceObject.metadata.labels['codemowers.io/sandbox']" },
    ],
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
  assert.match(denials[0].messages[0], /cannot create or update NetworkPolicies/)
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

// Observed on a real cluster: all three guards are bound with no
// namespaceSelector at all, so the ONLY scoping signal is the namespace label
// their CEL reads. Without honouring that, a sandbox guard reads as governing
// every namespace — including the platform ones it actually exempts.
const UNSCOPED_BINDING: RawAdmissionBinding = {
  metadata: { name: "sandbox-egress-guard-binding" },
  spec: { policyName: "sandbox-egress-guard", validationActions: ["Deny"] },
}

test("the namespace label the CEL reads is recorded", () => {
  const [fact] = toAdmissionFacts([EGRESS_GUARD], [UNSCOPED_BINDING])
  assert.deepEqual(fact.scopedToNamespaceLabelKeys, ["codemowers.io/sandbox"])
  // The binding really does carry no selector on the live clusters.
  assert.equal(fact.scopedToNamespaceLabels, null)
})

test("a binding with no selector still does not govern a non-sandbox namespace", () => {
  const facts = toAdmissionFacts([EGRESS_GUARD], [UNSCOPED_BINDING])
  const check = { group: "networking.k8s.io", resource: "networkpolicies", operation: "CREATE" } as const

  // A sandbox: governed.
  assert.equal(denialsFor(facts, { ...check, namespaceLabels: SANDBOX_SCOPE }).length, 1)
  // A platform namespace such as driftmowers: not governed, because the CEL
  // keys on a label it does not carry.
  assert.equal(denialsFor(facts, { ...check, namespaceLabels: {} }).length, 0)
})

test("the label only has to be present, not equal to any particular value", () => {
  const facts = toAdmissionFacts([EGRESS_GUARD], [UNSCOPED_BINDING])
  const denials = denialsFor(facts, {
    group: "networking.k8s.io",
    resource: "networkpolicies",
    operation: "CREATE",
    // A different sandbox id is still a sandbox.
    namespaceLabels: { "codemowers.io/sandbox": "z9y8x7-other" },
  })
  assert.equal(denials.length, 1)
})

test("a policy whose CEL reads no namespace label governs everywhere", () => {
  const global: RawAdmissionPolicy = {
    metadata: { name: "global-guard" },
    spec: {
      matchConstraints: { resourceRules: [{ apiGroups: [""], resources: ["pods"], operations: ["CREATE"] }] },
      validations: [{ message: "no" }],
    },
  }
  const facts = toAdmissionFacts([global], [{ spec: { policyName: "global-guard", validationActions: ["Deny"] } }])
  assert.equal(
    denialsFor(facts, { group: "", resource: "pods", operation: "CREATE", namespaceLabels: {} }).length,
    1,
  )
})

test("an explicit binding selector still wins over the CEL signal", () => {
  const facts = toAdmissionFacts([EGRESS_GUARD], [bindingFor("sandbox-egress-guard")])
  const check = { group: "networking.k8s.io", resource: "networkpolicies", operation: "CREATE" } as const

  // The binding pins one sandbox id, so another sandbox is not governed by it.
  assert.equal(denialsFor(facts, { ...check, namespaceLabels: SANDBOX_SCOPE }).length, 1)
  assert.equal(
    denialsFor(facts, { ...check, namespaceLabels: { "codemowers.io/sandbox": "z9y8x7-other" } }).length,
    0,
  )
})

// Real shape, read off the deployed sandbox-egress-guard: it exempts by
// IDENTITY (argocd/kube-system service accounts, admin groups, system:masters)
// rather than by namespace, and it carries TWO messages — a specific one about
// platform-managed policies and a blanket one. Only the blanket one explains a
// beginner's failure, so taking messages[0] alone loses the useful half.
const DEPLOYED_EGRESS_GUARD: RawAdmissionPolicy = {
  metadata: { name: "sandbox-egress-guard" },
  spec: {
    matchConstraints: {
      resourceRules: [
        { apiGroups: ["networking.k8s.io"], operations: ["CREATE", "UPDATE", "DELETE"], resources: ["networkpolicies"] },
      ],
    },
    variables: [
      {
        name: "exempt",
        expression:
          "request.userInfo.username.startsWith('system:serviceaccount:argocd:') || " +
          "('github.com:codemowers:admins' in request.userInfo.groups) || " +
          "('system:masters' in request.userInfo.groups)",
      },
    ],
    validations: [
      { expression: "variables.exempt || !variables.platformManaged", message: "platform-managed NetworkPolicies cannot be created, modified, or deleted by sandbox users" },
      { expression: "variables.exempt || request.operation == 'DELETE'", message: "NetworkPolicies in sandboxes are platform-managed and cannot be created or modified; custom traffic allowances are not yet self-service" },
    ],
  },
}

const DEPLOYED_BINDING: RawAdmissionBinding = {
  spec: { policyName: "sandbox-egress-guard", validationActions: ["Deny"] },
}

test("exempt groups are parsed out of the CEL", () => {
  const [fact] = toAdmissionFacts([DEPLOYED_EGRESS_GUARD], [DEPLOYED_BINDING])
  assert.deepEqual(fact.exemptGroups, ["github.com:codemowers:admins", "system:masters"])
})

test("both messages survive, and the blanket rule is among them", () => {
  const denials = denialsFor(toAdmissionFacts([DEPLOYED_EGRESS_GUARD], [DEPLOYED_BINDING]), {
    group: "networking.k8s.io",
    resource: "networkpolicies",
    operation: "CREATE",
    namespaceLabels: SANDBOX_SCOPE,
    callerGroups: [],
  })

  assert.equal(denials.length, 1)
  assert.equal(denials[0].messages.length, 2)
  assert.ok(denials[0].messages.some(m => /cannot be created or modified/.test(m)))
})

test("an admin is not told they are blocked, because the policy exempts them", () => {
  const facts = toAdmissionFacts([DEPLOYED_EGRESS_GUARD], [DEPLOYED_BINDING])
  const check = {
    group: "networking.k8s.io",
    resource: "networkpolicies",
    operation: "CREATE" as const,
    namespaceLabels: SANDBOX_SCOPE,
  }

  assert.equal(denialsFor(facts, { ...check, callerGroups: [] }).length, 1)
  assert.equal(denialsFor(facts, { ...check, callerGroups: ["github.com:codemowers:admins"] }).length, 0)
  assert.equal(denialsFor(facts, { ...check, callerGroups: ["system:masters"] }).length, 0)
  // An unrelated group is not an exemption.
  assert.equal(denialsFor(facts, { ...check, callerGroups: ["github.com:codemowers:users"] }).length, 1)
})

test("DELETE is still governed, since validation 1 protects platform-managed names", () => {
  const facts = toAdmissionFacts([DEPLOYED_EGRESS_GUARD], [DEPLOYED_BINDING])
  assert.equal(
    denialsFor(facts, {
      group: "networking.k8s.io",
      resource: "networkpolicies",
      operation: "DELETE",
      namespaceLabels: SANDBOX_SCOPE,
      callerGroups: [],
    }).length,
    1,
  )
})

// platform-manager/deploy/sandbox-guard.yaml: it shapes Buckets and S3Users a
// sandbox may create, so it must not read as a ban on creating them.
const S3_GUARD: RawAdmissionPolicy = {
  metadata: { name: "sandbox-s3-guard", annotations: { "codemowers.io/admission-effect": "constrains" } },
  spec: {
    matchConstraints: {
      resourceRules: [
        { apiGroups: ["s3.onyxia.sh"], apiVersions: ["*"], operations: ["CREATE", "UPDATE"], resources: ["buckets", "s3users"] },
      ],
    },
    variables: [{ name: "prefix", expression: "namespaceObject.metadata.labels['codemowers.io/sandbox'] + '-'" }],
    validations: [{ message: "only Buckets and S3Users can be created in sandboxes" }],
  },
}

test("a policy annotated as constraining fields is not reported as a denial", () => {
  const facts = toAdmissionFacts([S3_GUARD], [bindingFor("sandbox-s3-guard")])
  assert.equal(facts[0].effect, "constrains")
  assert.equal(facts[0].enforced, true)
  const check = { group: "s3.onyxia.sh", resource: "buckets", operation: "CREATE" as const, namespaceLabels: SANDBOX_SCOPE }
  assert.deepEqual(denialsFor(facts, check), [])
})

test("without the annotation a policy still denies, so nothing loosens by default", () => {
  const unannotated = { ...S3_GUARD, metadata: { name: "sandbox-s3-guard" } }
  const facts = toAdmissionFacts([unannotated], [bindingFor("sandbox-s3-guard")])
  assert.equal(facts[0].effect, "denies")
  const check = { group: "s3.onyxia.sh", resource: "buckets", operation: "CREATE" as const, namespaceLabels: SANDBOX_SCOPE }
  assert.equal(denialsFor(facts, check).length, 1)
})
