import { expect, it } from 'vitest'

import {
  computeHeadroom,
  containerDefaults,
  coversInstance,
  detectPosture,
  extractSelectors,
  type RawCiliumPolicy,
  type RawNetworkPolicy
} from './namespace-facts.js'

// The real sandbox-stack bundle, transcribed from
// platform-manager/charts/sandbox-stack/templates/networkpolicy.yaml.
const SANDBOX_NATIVE: RawNetworkPolicy[] = [
  {
    metadata: { name: 'default-deny-ingress' },
    spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [] }
  },
  {
    metadata: { name: 'internal-ingress' },
    spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [{ from: [{ podSelector: {} }] }] }
  },
  {
    metadata: { name: 'default-deny-egress' },
    spec: { podSelector: {}, policyTypes: ['Egress'], egress: [] }
  },
  {
    metadata: { name: 'dns-egress' },
    spec: { podSelector: {}, policyTypes: ['Egress'], egress: [{ to: [{ namespaceSelector: {} }] }] }
  },
  // Ingress on 8000 from the operator — hardcoded to the name "database".
  {
    metadata: { name: 'cnpg-operator' },
    spec: {
      podSelector: { matchLabels: { 'cnpg.io/cluster': 'database' } },
      policyTypes: ['Ingress'],
      ingress: [{ from: [{ namespaceSelector: {} }] }]
    }
  },
  // The newer apiserver egress policy — name-agnostic via Exists.
  {
    metadata: { name: 'apiserver-egress-cnpg' },
    spec: {
      podSelector: { matchExpressions: [{ key: 'cnpg.io/cluster', operator: 'Exists' }] },
      policyTypes: ['Egress'],
      egress: [{ to: [{ ipBlock: { cidr: '10.0.0.0/16' } }] }]
    }
  }
]

const SANDBOX_CILIUM: RawCiliumPolicy[] = [
  {
    metadata: { name: 'database-health-probes' },
    spec: {
      endpointSelector: { matchLabels: { 'cnpg.io/cluster': 'database' } },
      ingress: [{ fromEntities: ['host', 'remote-node', 'world'] }]
    }
  },
  {
    metadata: { name: 'database-kube-apiserver' },
    spec: {
      endpointSelector: { matchLabels: { 'cnpg.io/cluster': 'database' } },
      egress: [{ toEntities: ['kube-apiserver'] }]
    }
  }
]

it('the sandbox bundle is default-deny in both directions', () => {
  expect(detectPosture(SANDBOX_NATIVE, 'Ingress')).toBe('default-deny')
  expect(detectPosture(SANDBOX_NATIVE, 'Egress')).toBe('default-deny')
})

it('a namespace with no policies is open', () => {
  expect(detectPosture([], 'Ingress')).toBe('open')
  expect(detectPosture([], 'Egress')).toBe('open')
})

it('a policy that permits something is not default-deny', () => {
  const allow: RawNetworkPolicy[] = [
    { metadata: { name: 'a' }, spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [{ from: [] }] } }
  ]

  expect(detectPosture(allow, 'Ingress')).toBe('open')
})

it('omitted policyTypes defaults to Ingress, so deny-all is still detected', () => {
  // Kubernetes fills policyTypes in; reading the field blindly would miss this.
  const implicit: RawNetworkPolicy[] = [{ metadata: { name: 'a' }, spec: { podSelector: {} } }]

  expect(detectPosture(implicit, 'Ingress')).toBe('default-deny')
  expect(detectPosture(implicit, 'Egress')).toBe('open')
})

it('a policy scoped to specific pods never counts as default-deny', () => {
  const scoped: RawNetworkPolicy[] = [
    {
      metadata: { name: 'a' },
      spec: { podSelector: { matchLabels: { app: 'x' } }, policyTypes: ['Ingress'], ingress: [] }
    }
  ]

  expect(detectPosture(scoped, 'Ingress')).toBe('open')
})

it('both selector shapes are extracted, and only Exists is name-agnostic', () => {
  const selectors = extractSelectors('cnpg.io/cluster', SANDBOX_NATIVE, SANDBOX_CILIUM)

  const operatorIngress = selectors.find(s => s.policy === 'cnpg-operator')

  expect(operatorIngress?.labelValue).toBe('database')

  const apiserverEgress = selectors.find(s => s.policy === 'apiserver-egress-cnpg')

  // Exists -> null, meaning it covers any instance name.
  expect(apiserverEgress?.labelValue).toBe(null)

  const probes = selectors.find(s => s.policy === 'database-health-probes')

  expect(probes?.kind).toBe('CiliumNetworkPolicy')
  expect(probes?.labelValue).toBe('database')
  expect(probes?.admits ?? '').toMatch(/host, remote-node, world/)
})

it('policies that do not mention the label are ignored', () => {
  const selectors = extractSelectors('cnpg.io/cluster', SANDBOX_NATIVE, SANDBOX_CILIUM)

  expect(selectors.some(s => s.policy === 'default-deny-ingress')).toBe(false)
  expect(selectors.some(s => s.policy === 'dns-egress')).toBe(false)
})

it('this is the trap: an instance not named database loses its probe ingress', () => {
  const selectors = extractSelectors('cnpg.io/cluster', SANDBOX_NATIVE, SANDBOX_CILIUM)

  // Named `database`, everything the sandbox pre-rendered applies.
  expect(coversInstance(selectors, 'database', 'Ingress')).toBe(true)
  // Named anything else, the exact-name policies stop matching...
  expect(coversInstance(selectors, 'orders-db', 'Ingress')).toBe(false)
  // ...but the Exists-based apiserver egress still covers it.
  expect(coversInstance(selectors, 'orders-db', 'Egress')).toBe(true)
})

it('coversInstance can require a specific kind of admission', () => {
  const selectors = extractSelectors('cnpg.io/cluster', SANDBOX_NATIVE, SANDBOX_CILIUM)
  const nodeSourced = (s: { admits: string }) => /remote-node/.test(s.admits)

  expect(coversInstance(selectors, 'database', 'Ingress', nodeSourced)).toBe(true)
  // Node-sourced health probes need an entity rule; a pod-selector rule cannot
  // admit them, so requiring the entity shape is what makes the check honest.
  expect(coversInstance(selectors, 'orders-db', 'Ingress', nodeSourced)).toBe(false)
})

it('headroom is hard minus used, per the smallest real sandbox quota', () => {
  const headroom = computeHeadroom({
    metadata: { name: 'sandbox-quota' },
    status: {
      hard: {
        'requests.cpu': '1',
        'requests.memory': '2Gi',
        'requests.storage': '10Gi',
        persistentvolumeclaims: '5',
        pods: '50'
      },
      used: {
        'requests.cpu': '100m',
        'requests.memory': '1434Mi',
        'requests.storage': '3Gi',
        persistentvolumeclaims: '1',
        pods: '4'
      }
    }
  })

  expect(headroom?.cpuMillis).toBe(900)
  expect(headroom?.storageBytes).toBe(7 * 1024 ** 3)
  expect(headroom?.pvcCount).toBe(4)
  expect(headroom?.pods).toBe(46)
  expect(headroom?.memoryBytes).toBe(2 * 1024 ** 3 - 1434 * 1024 ** 2)
})

it('a dimension the quota does not cap is unlimited, not zero', () => {
  const headroom = computeHeadroom({ status: { hard: { pods: '50' }, used: {} } })

  expect(headroom?.pods).toBe(50)
  // Inventing a 0 cap here would block every plan with a fabricated blocker.
  expect(headroom?.storageBytes).toBe(null)
  expect(headroom?.cpuMillis).toBe(null)
})

it('headroom never goes negative when usage already exceeds the cap', () => {
  const headroom = computeHeadroom({
    status: { hard: { 'requests.storage': '10Gi' }, used: { 'requests.storage': '12Gi' } }
  })

  expect(headroom?.storageBytes).toBe(0)
})

it('status wins over spec, because status is what is enforced', () => {
  const headroom = computeHeadroom({
    spec: { hard: { pods: '999' } },
    status: { hard: { pods: '50' }, used: { pods: '1' } }
  })

  expect(headroom?.pods).toBe(49)
})

it('no quota at all means no headroom object', () => {
  expect(computeHeadroom(null)).toBe(null)
})

it('the LimitRange container default is found, since it OOM-kills Postgres', () => {
  const defaults = containerDefaults([
    {
      metadata: { name: 'sandbox-limits' },
      spec: {
        limits: [
          { type: 'Container', defaultRequest: { cpu: '50m', memory: '64Mi' }, default: { memory: '256Mi' } }
        ]
      }
    }
  ])

  expect(defaults?.default.memory).toBe('256Mi')
  expect(defaults?.defaultRequest.cpu).toBe('50m')
})

it('a LimitRange scoped to something other than Container is ignored', () => {
  expect(containerDefaults([{ spec: { limits: [{ type: 'Pod', default: { memory: '1Gi' } }] } }])).toBe(null)
  expect(containerDefaults([])).toBe(null)
})
