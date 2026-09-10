import assert from "node:assert/strict"
import { test } from "node:test"

import {
  computeHeadroom,
  containerDefaults,
  coversInstance,
  detectPosture,
  extractSelectors,
  type RawCiliumPolicy,
  type RawNetworkPolicy,
} from "./namespace-facts.ts"

// The real sandbox-stack bundle, transcribed from
// platform-manager/charts/sandbox-stack/templates/networkpolicy.yaml.
const SANDBOX_NATIVE: RawNetworkPolicy[] = [
  { metadata: { name: "default-deny-ingress" }, spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [] } },
  {
    metadata: { name: "internal-ingress" },
    spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [{ from: [{ podSelector: {} }] }] },
  },
  { metadata: { name: "default-deny-egress" }, spec: { podSelector: {}, policyTypes: ["Egress"], egress: [] } },
  {
    metadata: { name: "dns-egress" },
    spec: { podSelector: {}, policyTypes: ["Egress"], egress: [{ to: [{ namespaceSelector: {} }] }] },
  },
  // Ingress on 8000 from the operator — hardcoded to the name "database".
  {
    metadata: { name: "cnpg-operator" },
    spec: {
      podSelector: { matchLabels: { "cnpg.io/cluster": "database" } },
      policyTypes: ["Ingress"],
      ingress: [{ from: [{ namespaceSelector: {} }] }],
    },
  },
  // The newer apiserver egress policy — name-agnostic via Exists.
  {
    metadata: { name: "apiserver-egress-cnpg" },
    spec: {
      podSelector: { matchExpressions: [{ key: "cnpg.io/cluster", operator: "Exists" }] },
      policyTypes: ["Egress"],
      egress: [{ to: [{ ipBlock: { cidr: "10.0.0.0/16" } }] }],
    },
  },
]

const SANDBOX_CILIUM: RawCiliumPolicy[] = [
  {
    metadata: { name: "database-health-probes" },
    spec: {
      endpointSelector: { matchLabels: { "cnpg.io/cluster": "database" } },
      ingress: [{ fromEntities: ["host", "remote-node", "world"] }],
    },
  },
  {
    metadata: { name: "database-kube-apiserver" },
    spec: {
      endpointSelector: { matchLabels: { "cnpg.io/cluster": "database" } },
      egress: [{ toEntities: ["kube-apiserver"] }],
    },
  },
]

test("the sandbox bundle is default-deny in both directions", () => {
  assert.equal(detectPosture(SANDBOX_NATIVE, "Ingress"), "default-deny")
  assert.equal(detectPosture(SANDBOX_NATIVE, "Egress"), "default-deny")
})

test("a namespace with no policies is open", () => {
  assert.equal(detectPosture([], "Ingress"), "open")
  assert.equal(detectPosture([], "Egress"), "open")
})

test("a policy that permits something is not default-deny", () => {
  const allow: RawNetworkPolicy[] = [
    { metadata: { name: "a" }, spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [{ from: [] }] } },
  ]
  assert.equal(detectPosture(allow, "Ingress"), "open")
})

test("omitted policyTypes defaults to Ingress, so deny-all is still detected", () => {
  // Kubernetes fills policyTypes in; reading the field blindly would miss this.
  const implicit: RawNetworkPolicy[] = [{ metadata: { name: "a" }, spec: { podSelector: {} } }]
  assert.equal(detectPosture(implicit, "Ingress"), "default-deny")
  assert.equal(detectPosture(implicit, "Egress"), "open")
})

test("a policy scoped to specific pods never counts as default-deny", () => {
  const scoped: RawNetworkPolicy[] = [
    {
      metadata: { name: "a" },
      spec: { podSelector: { matchLabels: { app: "x" } }, policyTypes: ["Ingress"], ingress: [] },
    },
  ]
  assert.equal(detectPosture(scoped, "Ingress"), "open")
})

test("both selector shapes are extracted, and only Exists is name-agnostic", () => {
  const selectors = extractSelectors("cnpg.io/cluster", SANDBOX_NATIVE, SANDBOX_CILIUM)

  const operatorIngress = selectors.find(s => s.policy === "cnpg-operator")
  assert.equal(operatorIngress?.labelValue, "database")

  const apiserverEgress = selectors.find(s => s.policy === "apiserver-egress-cnpg")
  // Exists -> null, meaning it covers any instance name.
  assert.equal(apiserverEgress?.labelValue, null)

  const probes = selectors.find(s => s.policy === "database-health-probes")
  assert.equal(probes?.kind, "CiliumNetworkPolicy")
  assert.equal(probes?.labelValue, "database")
  assert.match(probes?.admits ?? "", /host, remote-node, world/)
})

test("policies that do not mention the label are ignored", () => {
  const selectors = extractSelectors("cnpg.io/cluster", SANDBOX_NATIVE, SANDBOX_CILIUM)
  assert.equal(selectors.some(s => s.policy === "default-deny-ingress"), false)
  assert.equal(selectors.some(s => s.policy === "dns-egress"), false)
})

test("this is the trap: an instance not named database loses its probe ingress", () => {
  const selectors = extractSelectors("cnpg.io/cluster", SANDBOX_NATIVE, SANDBOX_CILIUM)

  // Named `database`, everything the sandbox pre-rendered applies.
  assert.equal(coversInstance(selectors, "database", "Ingress"), true)
  // Named anything else, the exact-name policies stop matching...
  assert.equal(coversInstance(selectors, "orders-db", "Ingress"), false)
  // ...but the Exists-based apiserver egress still covers it.
  assert.equal(coversInstance(selectors, "orders-db", "Egress"), true)
})

test("coversInstance can require a specific kind of admission", () => {
  const selectors = extractSelectors("cnpg.io/cluster", SANDBOX_NATIVE, SANDBOX_CILIUM)
  const nodeSourced = (s: { admits: string }) => /remote-node/.test(s.admits)

  assert.equal(coversInstance(selectors, "database", "Ingress", nodeSourced), true)
  // Node-sourced health probes need an entity rule; a pod-selector rule cannot
  // admit them, so requiring the entity shape is what makes the check honest.
  assert.equal(coversInstance(selectors, "orders-db", "Ingress", nodeSourced), false)
})

test("headroom is hard minus used, per the smallest real sandbox quota", () => {
  const headroom = computeHeadroom({
    metadata: { name: "sandbox-quota" },
    status: {
      hard: {
        "requests.cpu": "1",
        "requests.memory": "2Gi",
        "requests.storage": "10Gi",
        persistentvolumeclaims: "5",
        pods: "50",
      },
      used: { "requests.cpu": "100m", "requests.memory": "1434Mi", "requests.storage": "3Gi", persistentvolumeclaims: "1", pods: "4" },
    },
  })

  assert.equal(headroom?.cpuMillis, 900)
  assert.equal(headroom?.storageBytes, 7 * 1024 ** 3)
  assert.equal(headroom?.pvcCount, 4)
  assert.equal(headroom?.pods, 46)
  assert.equal(headroom?.memoryBytes, 2 * 1024 ** 3 - 1434 * 1024 ** 2)
})

test("a dimension the quota does not cap is unlimited, not zero", () => {
  const headroom = computeHeadroom({ status: { hard: { pods: "50" }, used: {} } })
  assert.equal(headroom?.pods, 50)
  // Inventing a 0 cap here would block every plan with a fabricated blocker.
  assert.equal(headroom?.storageBytes, null)
  assert.equal(headroom?.cpuMillis, null)
})

test("headroom never goes negative when usage already exceeds the cap", () => {
  const headroom = computeHeadroom({ status: { hard: { "requests.storage": "10Gi" }, used: { "requests.storage": "12Gi" } } })
  assert.equal(headroom?.storageBytes, 0)
})

test("status wins over spec, because status is what is enforced", () => {
  const headroom = computeHeadroom({
    spec: { hard: { pods: "999" } },
    status: { hard: { pods: "50" }, used: { pods: "1" } },
  })
  assert.equal(headroom?.pods, 49)
})

test("no quota at all means no headroom object", () => {
  assert.equal(computeHeadroom(null), null)
})

test("the LimitRange container default is found, since it OOM-kills Postgres", () => {
  const defaults = containerDefaults([
    {
      metadata: { name: "sandbox-limits" },
      spec: { limits: [{ type: "Container", defaultRequest: { cpu: "50m", memory: "64Mi" }, default: { memory: "256Mi" } }] },
    },
  ])
  assert.equal(defaults?.default.memory, "256Mi")
  assert.equal(defaults?.defaultRequest.cpu, "50m")
})

test("a LimitRange scoped to something other than Container is ignored", () => {
  assert.equal(containerDefaults([{ spec: { limits: [{ type: "Pod", default: { memory: "1Gi" } }] } }]), null)
  assert.equal(containerDefaults([]), null)
})
