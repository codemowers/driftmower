import { expect, it } from 'vitest'

import {
  admissionFor,
  denialsFor,
  effectOf,
  selectorMatches,
  tenantLabelKeyFor,
  toAdmissionFact,
  toAdmissionFacts,
  type RawAdmissionBinding,
  type RawAdmissionPolicy
} from './admission-facts.js'

// The real guards, from platform-manager/deploy/{egress,sandbox}-guard.yaml.
const EGRESS_GUARD: RawAdmissionPolicy = {
  metadata: { name: 'sandbox-egress-guard' },
  spec: {
    failurePolicy: 'Fail',
    matchConstraints: {
      resourceRules: [
        {
          apiGroups: ['networking.k8s.io'],
          apiVersions: ['v1'],
          operations: ['CREATE', 'UPDATE', 'DELETE'],
          resources: ['networkpolicies']
        }
      ]
    },
    variables: [{ name: 'sandbox', expression: "namespaceObject.metadata.labels['codemowers.io/sandbox']" }],
    validations: [{ message: 'Sandbox users cannot create or update NetworkPolicies', reason: 'Forbidden' }]
  }
}

const INGRESS_GUARD: RawAdmissionPolicy = {
  metadata: { name: 'sandbox-ingress-guard' },
  spec: {
    paramKind: { apiVersion: 'v1', kind: 'ConfigMap' },
    matchConstraints: {
      resourceRules: [
        { apiGroups: ['networking.k8s.io'], operations: ['CREATE', 'UPDATE'], resources: ['ingresses'] },
        { apiGroups: ['traefik.io'], operations: ['CREATE', 'UPDATE'], resources: ['ingressroutes'] }
      ]
    },
    variables: [{ name: 'sandbox', expression: "namespaceObject.metadata.labels['codemowers.io/sandbox']" }],
    validations: [
      {
        message: 'Traefik IngressRoute resources are not available in sandboxes; use a\n  standard Ingress'
      },
      { message: 'Ingress hosts in this sandbox must be <sandbox-id>.<domain> or' }
    ]
  }
}

const SANDBOX_SCOPE = { 'codemowers.io/sandbox': 'abc123-demo' }

function bindingFor(
  policyName: string,
  over: Partial<NonNullable<RawAdmissionBinding['spec']>> = {}
): RawAdmissionBinding {
  return {
    metadata: { name: `${policyName}-binding` },
    spec: {
      policyName,
      matchResources: { namespaceSelector: { matchLabels: { 'codemowers.io/sandbox': 'abc123-demo' } } },
      ...over
    }
  }
}

it('a bound policy is enforced and keeps its own human message', () => {
  const [fact] = toAdmissionFacts([EGRESS_GUARD], [bindingFor('sandbox-egress-guard')])

  expect(fact.name).toBe('sandbox-egress-guard')
  expect(fact.enforced).toBe(true)
  expect(fact.guards).toEqual([
    { group: 'networking.k8s.io', resource: 'networkpolicies', operations: ['CREATE', 'UPDATE', 'DELETE'] }
  ])
  expect(fact.messages[0]).toMatch(/cannot create or update NetworkPolicies/)
})

it('validationActions defaults to Deny when a binding omits it', () => {
  const [fact] = toAdmissionFacts(
    [EGRESS_GUARD],
    [bindingFor('sandbox-egress-guard', { validationActions: undefined })]
  )

  expect(fact.enforced).toBe(true)
})

it('an Audit-only binding does not block, and says so', () => {
  const [fact] = toAdmissionFacts(
    [EGRESS_GUARD],
    [bindingFor('sandbox-egress-guard', { validationActions: ['Audit'] })]
  )

  expect(fact.enforced).toBe(false)
  expect(fact.enforcement).toMatch(/will not block/)
})

it('an unbound policy does nothing at all', () => {
  const [fact] = toAdmissionFacts([EGRESS_GUARD], [])

  expect(fact.enforced).toBe(false)
  expect(fact.enforcement).toMatch(/no binding/)
})

it('messages are whitespace-normalised, since YAML folds them across lines', () => {
  const [fact] = toAdmissionFacts([INGRESS_GUARD], [bindingFor('sandbox-ingress-guard')])

  expect(
    fact.messages.some(
      m => m === 'Traefik IngressRoute resources are not available in sandboxes; use a standard Ingress'
    )
  ).toBeTruthy()
})

it('the params ConfigMap is reported, so the caller knows to fetch it', () => {
  const [fact] = toAdmissionFacts(
    [INGRESS_GUARD],
    [
      bindingFor('sandbox-ingress-guard', {
        paramRef: { name: 'sandbox-guard-params', namespace: 'kube-system' }
      })
    ]
  )

  expect(fact.paramRef).toEqual({ name: 'sandbox-guard-params', namespace: 'kube-system' })
})

it('this is the correction: netpol creation is denied where RBAC would allow it', () => {
  const facts = toAdmissionFacts([EGRESS_GUARD], [bindingFor('sandbox-egress-guard')])

  const denials = denialsFor(facts, {
    group: 'networking.k8s.io',
    resource: 'networkpolicies',
    operation: 'CREATE',
    namespaceLabels: SANDBOX_SCOPE
  })

  expect(denials.length).toBe(1)
  expect(denials[0].policy).toBe('sandbox-egress-guard')
  expect(denials[0].messages[0]).toMatch(/cannot create or update NetworkPolicies/)
})

it('a policy scoped to sandboxes does not apply to a namespace that is not one', () => {
  const facts = toAdmissionFacts([EGRESS_GUARD], [bindingFor('sandbox-egress-guard')])

  const denials = denialsFor(facts, {
    group: 'networking.k8s.io',
    resource: 'networkpolicies',
    operation: 'CREATE',
    // A platform namespace carries no sandbox label.
    namespaceLabels: {}
  })

  expect(denials).toEqual([])
})

it('an unrelated resource is not swept up', () => {
  const facts = toAdmissionFacts([EGRESS_GUARD], [bindingFor('sandbox-egress-guard')])

  expect(
    denialsFor(facts, {
      group: 'postgresql.cnpg.io',
      resource: 'clusters',
      operation: 'CREATE',
      namespaceLabels: SANDBOX_SCOPE
    })
  ).toEqual([])
})

it('DELETE is distinguished from CREATE, since deleting leftovers stays allowed', () => {
  // The ingress guard only matches CREATE and UPDATE.
  const facts = toAdmissionFacts([INGRESS_GUARD], [bindingFor('sandbox-ingress-guard')])
  const check = { group: 'networking.k8s.io', resource: 'ingresses', namespaceLabels: SANDBOX_SCOPE } as const

  expect(denialsFor(facts, { ...check, operation: 'CREATE' }).length).toBe(1)
  expect(denialsFor(facts, { ...check, operation: 'DELETE' }).length).toBe(0)
})

it('a wildcard rule matches any group or resource it is written over', () => {
  const wildcard: RawAdmissionPolicy = {
    metadata: { name: 'catch-all' },
    spec: { matchConstraints: { resourceRules: [{ apiGroups: ['*'], resources: ['*'], operations: ['*'] }] } }
  }
  const facts = toAdmissionFacts([wildcard], [bindingFor('catch-all')])

  expect(
    denialsFor(facts, {
      group: 'anything.io',
      resource: 'widgets',
      operation: 'UPDATE',
      namespaceLabels: SANDBOX_SCOPE
    }).length
  ).toBe(1)
})

it('enforced policies sort ahead of inert ones', () => {
  const facts = toAdmissionFacts([INGRESS_GUARD, EGRESS_GUARD], [bindingFor('sandbox-egress-guard')])

  expect(facts.map(f => [f.name, f.enforced])).toEqual([
    ['sandbox-egress-guard', true],
    ['sandbox-ingress-guard', false]
  ])
})

// Observed on a real cluster: all three guards are bound with no
// namespaceSelector at all, so the ONLY scoping signal is the namespace label
// their CEL reads. Without honouring that, a sandbox guard reads as governing
// every namespace — including the platform ones it actually exempts.
const UNSCOPED_BINDING: RawAdmissionBinding = {
  metadata: { name: 'sandbox-egress-guard-binding' },
  spec: { policyName: 'sandbox-egress-guard', validationActions: ['Deny'] }
}

it('the namespace label the CEL reads is recorded', () => {
  const [fact] = toAdmissionFacts([EGRESS_GUARD], [UNSCOPED_BINDING])

  expect(fact.scopedToNamespaceLabelKeys).toEqual(['codemowers.io/sandbox'])
  // The binding really does carry no selector on the live clusters.
  expect(fact.scopedToNamespaceLabels).toBe(null)
})

it('a binding with no selector still does not govern a non-sandbox namespace', () => {
  const facts = toAdmissionFacts([EGRESS_GUARD], [UNSCOPED_BINDING])
  const check = { group: 'networking.k8s.io', resource: 'networkpolicies', operation: 'CREATE' } as const

  // A sandbox: governed.
  expect(denialsFor(facts, { ...check, namespaceLabels: SANDBOX_SCOPE }).length).toBe(1)
  // A platform namespace such as driftmowers: not governed, because the CEL
  // keys on a label it does not carry.
  expect(denialsFor(facts, { ...check, namespaceLabels: {} }).length).toBe(0)
})

it('the label only has to be present, not equal to any particular value', () => {
  const facts = toAdmissionFacts([EGRESS_GUARD], [UNSCOPED_BINDING])
  const denials = denialsFor(facts, {
    group: 'networking.k8s.io',
    resource: 'networkpolicies',
    operation: 'CREATE',
    // A different sandbox id is still a sandbox.
    namespaceLabels: { 'codemowers.io/sandbox': 'z9y8x7-other' }
  })

  expect(denials.length).toBe(1)
})

it('a policy whose CEL reads no namespace label governs everywhere', () => {
  const global: RawAdmissionPolicy = {
    metadata: { name: 'global-guard' },
    spec: {
      matchConstraints: { resourceRules: [{ apiGroups: [''], resources: ['pods'], operations: ['CREATE'] }] },
      validations: [{ message: 'no' }]
    }
  }
  const facts = toAdmissionFacts(
    [global],
    [{ spec: { policyName: 'global-guard', validationActions: ['Deny'] } }]
  )

  expect(
    denialsFor(facts, { group: '', resource: 'pods', operation: 'CREATE', namespaceLabels: {} }).length
  ).toBe(1)
})

it('an explicit binding selector still wins over the CEL signal', () => {
  const facts = toAdmissionFacts([EGRESS_GUARD], [bindingFor('sandbox-egress-guard')])
  const check = { group: 'networking.k8s.io', resource: 'networkpolicies', operation: 'CREATE' } as const

  // The binding pins one sandbox id, so another sandbox is not governed by it.
  expect(denialsFor(facts, { ...check, namespaceLabels: SANDBOX_SCOPE }).length).toBe(1)
  expect(
    denialsFor(facts, { ...check, namespaceLabels: { 'codemowers.io/sandbox': 'z9y8x7-other' } }).length
  ).toBe(0)
})

// Real shape, read off the deployed sandbox-egress-guard: it exempts by
// IDENTITY (argocd/kube-system service accounts, admin groups, system:masters)
// rather than by namespace, and it carries TWO messages — a specific one about
// platform-managed policies and a blanket one. Only the blanket one explains a
// beginner's failure, so taking messages[0] alone loses the useful half.
const DEPLOYED_EGRESS_GUARD: RawAdmissionPolicy = {
  metadata: { name: 'sandbox-egress-guard' },
  spec: {
    matchConstraints: {
      resourceRules: [
        {
          apiGroups: ['networking.k8s.io'],
          operations: ['CREATE', 'UPDATE', 'DELETE'],
          resources: ['networkpolicies']
        }
      ]
    },
    variables: [
      {
        name: 'exempt',
        expression:
          "request.userInfo.username.startsWith('system:serviceaccount:argocd:') || " +
          "('github.com:codemowers:admins' in request.userInfo.groups) || " +
          "('system:masters' in request.userInfo.groups)"
      }
    ],
    validations: [
      {
        expression: 'variables.exempt || !variables.platformManaged',
        message: 'platform-managed NetworkPolicies cannot be created, modified, or deleted by sandbox users'
      },
      {
        expression: "variables.exempt || request.operation == 'DELETE'",
        message:
          'NetworkPolicies in sandboxes are platform-managed and cannot be created or modified; custom traffic allowances are not yet self-service'
      }
    ]
  }
}

const DEPLOYED_BINDING: RawAdmissionBinding = {
  spec: { policyName: 'sandbox-egress-guard', validationActions: ['Deny'] }
}

it('exempt groups are parsed out of the CEL', () => {
  const [fact] = toAdmissionFacts([DEPLOYED_EGRESS_GUARD], [DEPLOYED_BINDING])

  expect(fact.exemptGroups).toEqual(['github.com:codemowers:admins', 'system:masters'])
})

it('both messages survive, and the blanket rule is among them', () => {
  const denials = denialsFor(toAdmissionFacts([DEPLOYED_EGRESS_GUARD], [DEPLOYED_BINDING]), {
    group: 'networking.k8s.io',
    resource: 'networkpolicies',
    operation: 'CREATE',
    namespaceLabels: SANDBOX_SCOPE,
    callerGroups: []
  })

  expect(denials.length).toBe(1)
  expect(denials[0].messages.length).toBe(2)
  expect(denials[0].messages.some(m => /cannot be created or modified/.test(m))).toBeTruthy()
})

it('an admin is not told they are blocked, because the policy exempts them', () => {
  const facts = toAdmissionFacts([DEPLOYED_EGRESS_GUARD], [DEPLOYED_BINDING])
  const check = {
    group: 'networking.k8s.io',
    resource: 'networkpolicies',
    operation: 'CREATE' as const,
    namespaceLabels: SANDBOX_SCOPE
  }

  expect(denialsFor(facts, { ...check, callerGroups: [] }).length).toBe(1)
  expect(denialsFor(facts, { ...check, callerGroups: ['github.com:codemowers:admins'] }).length).toBe(0)
  expect(denialsFor(facts, { ...check, callerGroups: ['system:masters'] }).length).toBe(0)
  // An unrelated group is not an exemption.
  expect(denialsFor(facts, { ...check, callerGroups: ['github.com:codemowers:users'] }).length).toBe(1)
})

it('DELETE is still governed, since validation 1 protects platform-managed names', () => {
  const facts = toAdmissionFacts([DEPLOYED_EGRESS_GUARD], [DEPLOYED_BINDING])

  expect(
    denialsFor(facts, {
      group: 'networking.k8s.io',
      resource: 'networkpolicies',
      operation: 'DELETE',
      namespaceLabels: SANDBOX_SCOPE,
      callerGroups: []
    }).length
  ).toBe(1)
})

// platform-manager/deploy/sandbox-guard.yaml: it shapes Buckets and S3Users a
// sandbox may create, so it must not read as a ban on creating them.
const S3_GUARD: RawAdmissionPolicy = {
  metadata: { name: 'sandbox-s3-guard', annotations: { 'codemowers.io/admission-effect': 'constrains' } },
  spec: {
    matchConstraints: {
      resourceRules: [
        {
          apiGroups: ['s3.onyxia.sh'],
          apiVersions: ['*'],
          operations: ['CREATE', 'UPDATE'],
          resources: ['buckets', 's3users']
        }
      ]
    },
    variables: [
      { name: 'prefix', expression: "namespaceObject.metadata.labels['codemowers.io/sandbox'] + '-'" }
    ],
    validations: [{ message: 'only Buckets and S3Users can be created in sandboxes' }]
  }
}

it('a policy annotated as constraining fields is not reported as a denial', () => {
  const facts = toAdmissionFacts([S3_GUARD], [bindingFor('sandbox-s3-guard')])

  expect(facts[0].effect).toBe('constrains')
  expect(facts[0].enforced).toBe(true)
  const check = {
    group: 's3.onyxia.sh',
    resource: 'buckets',
    operation: 'CREATE' as const,
    namespaceLabels: SANDBOX_SCOPE
  }

  expect(denialsFor(facts, check)).toEqual([])
})

it('without the annotation, a validation that reads no object field still denies', () => {
  const unannotated = { ...S3_GUARD, metadata: { name: 'sandbox-s3-guard' } }
  const facts = toAdmissionFacts([unannotated], [bindingFor('sandbox-s3-guard')])

  expect(facts[0].effect).toBe('denies')
  const check = {
    group: 's3.onyxia.sh',
    resource: 'buckets',
    operation: 'CREATE' as const,
    namespaceLabels: SANDBOX_SCOPE
  }

  expect(denialsFor(facts, check).length).toBe(1)
})

it('records every label key a binding selector mentions, by value or by expression', () => {
  const [fact] = toAdmissionFacts(
    [EGRESS_GUARD],
    [
      bindingFor('sandbox-egress-guard', {
        matchResources: {
          namespaceSelector: {
            matchLabels: { 'codemowers.io/sandbox': 'abc123-demo' },
            matchExpressions: [{ key: 'tier', operator: 'Exists' }]
          }
        }
      })
    ]
  )

  expect(fact.bindingLabelKeys).toEqual(['codemowers.io/sandbox', 'tier'])
})

it('discovers the tenant label from the enforced ingress guard, then any enforced guard, else nothing', () => {
  const exists: RawAdmissionBinding = {
    spec: {
      policyName: 'sandbox-ingress-guard',
      matchResources: {
        namespaceSelector: { matchExpressions: [{ key: 'team.example.com/tenant', operator: 'Exists' }] }
      }
    }
  }

  expect(tenantLabelKeyFor(toAdmissionFacts([INGRESS_GUARD], [exists]))).toBe('team.example.com/tenant')
  // No binding selector: the CEL is the witness.
  expect(
    tenantLabelKeyFor(
      toAdmissionFacts([INGRESS_GUARD], [UNSCOPED_BINDING, { spec: { policyName: 'sandbox-ingress-guard' } }])
    )
  ).toBe('codemowers.io/sandbox')
  // No ingress guard, but the egress guard is enforced and scoped.
  expect(tenantLabelKeyFor(toAdmissionFacts([EGRESS_GUARD], [UNSCOPED_BINDING]))).toBe(
    'codemowers.io/sandbox'
  )
  // Unbound policies scope nothing.
  expect(tenantLabelKeyFor(toAdmissionFacts([EGRESS_GUARD, INGRESS_GUARD], []))).toBe(null)
  expect(tenantLabelKeyFor([])).toBe(null)
})

it('projects the client-facing fact without the server-side pointers', () => {
  const [fact] = toAdmissionFacts(
    [INGRESS_GUARD],
    [bindingFor('sandbox-ingress-guard', { paramRef: { name: 'p', namespace: 'kube-system' } })]
  )

  expect(Object.keys(toAdmissionFact(fact)).sort()).toEqual([
    'enforced',
    'enforcement',
    'guards',
    'messages',
    'name',
    'scopedToNamespaceLabels'
  ])
})

it('a binding that selects by expression does not govern a namespace outside it', () => {
  // Observed on a live cluster: the egress guard's binding selects
  // `codemowers.io/sandbox Exists` and its CEL reads no namespace label, so
  // only the binding selector keeps it out of ordinary namespaces.
  const guard: RawAdmissionPolicy = {
    metadata: { name: 'sandbox-egress-guard' },
    spec: {
      matchConstraints: {
        resourceRules: [
          { apiGroups: ['networking.k8s.io'], operations: ['CREATE'], resources: ['networkpolicies'] }
        ]
      },
      validations: [{ message: 'no' }]
    }
  }
  const binding: RawAdmissionBinding = {
    spec: {
      policyName: 'sandbox-egress-guard',
      validationActions: ['Deny'],
      matchResources: {
        namespaceSelector: { matchExpressions: [{ key: 'codemowers.io/sandbox', operator: 'Exists' }] }
      }
    }
  }
  const facts = toAdmissionFacts([guard], [binding])
  const check = { group: 'networking.k8s.io', resource: 'networkpolicies', operation: 'CREATE' as const }

  expect(denialsFor(facts, { ...check, namespaceLabels: { 'codemowers.io/tenant': 'foo' } })).toEqual([])
  expect(denialsFor(facts, { ...check, namespaceLabels: { 'codemowers.io/sandbox': 'x' } })).toHaveLength(1)
})

it('selector semantics follow Kubernetes', () => {
  const labels = { tier: 'web', env: 'prod' }

  expect(selectorMatches({}, labels)).toBe(true)
  expect(selectorMatches({ matchLabels: { tier: 'web' } }, labels)).toBe(true)
  expect(selectorMatches({ matchLabels: { tier: 'db' } }, labels)).toBe(false)
  expect(
    selectorMatches({ matchExpressions: [{ key: 'env', operator: 'In', values: ['prod', 'stage'] }] }, labels)
  ).toBe(true)
  expect(
    selectorMatches({ matchExpressions: [{ key: 'env', operator: 'NotIn', values: ['prod'] }] }, labels)
  ).toBe(false)
  expect(
    selectorMatches({ matchExpressions: [{ key: 'team', operator: 'NotIn', values: ['a'] }] }, labels)
  ).toBe(true)
  expect(selectorMatches({ matchExpressions: [{ key: 'team', operator: 'DoesNotExist' }] }, labels)).toBe(
    true
  )
  expect(selectorMatches({ matchExpressions: [{ key: 'tier', operator: 'Bogus' }] }, labels)).toBe(false)
})

// The namespace-anchored ingress guard with custom domains, as in
// platform-manager's deploy/sandbox-guard.yaml since #17: the shape and the
// domains are read off its own CEL, not assumed.
it('notices which namespace annotations a guard reads and whether it anchors on the namespace', () => {
  const guard: RawAdmissionPolicy = {
    metadata: { name: 'sandbox-ingress-guard' },
    spec: {
      matchConstraints: {
        resourceRules: [{ apiGroups: ['networking.k8s.io'], apiVersions: ['v1'], operations: ['CREATE'], resources: ['ingresses'] }]
      },
      variables: [
        { name: 'space', expression: "'.' + request.namespace + variables.suffix" },
        {
          name: 'verified',
          expression:
            "has(namespaceObject.metadata.annotations) && 'codemowers.io/verified-domains' in namespaceObject.metadata.annotations ? namespaceObject.metadata.annotations['codemowers.io/verified-domains'].split(',') : []"
        }
      ],
      validations: [{ expression: 'variables.verified.size() >= 0' }]
    }
  }
  const legacy: RawAdmissionPolicy = {
    metadata: { name: 'old-guard' },
    spec: { variables: [{ name: 'sandbox', expression: "namespaceObject.metadata.labels['codemowers.io/sandbox']" }] }
  }

  const [fact] = toAdmissionFacts([guard], [{ spec: { policyName: 'sandbox-ingress-guard' } }])
  const [old] = toAdmissionFacts([legacy], [{ spec: { policyName: 'old-guard' } }])

  expect(fact!.namespaceAnnotationKeys).toEqual(['codemowers.io/verified-domains'])
  expect(fact!.anchorsOnNamespace).toBe(true)
  expect(old!.namespaceAnnotationKeys).toEqual([])
  expect(old!.anchorsOnNamespace).toBe(false)
})

// aws-us-west-2-bravo's default-namespace-block: denies every CREATE of every
// resource, but its matchConditions confine it to the `default` namespace. It
// used to read as denying every create in every sandbox.
it('a policy confined to one namespace by matchConditions does not deny elsewhere', () => {
  const policy: RawAdmissionPolicy = {
    metadata: { name: 'default-namespace-block' },
    spec: {
      matchConstraints: { resourceRules: [{ apiGroups: ['*'], apiVersions: ['*'], operations: ['CREATE'], resources: ['*'] }] },
      matchConditions: [
        { name: 'default-namespace', expression: "has(request.namespace) && request.namespace == 'default'" },
        { name: 'controller-managed-resources', expression: "!(request.resource.resource in ['endpoints', 'endpointslices', 'events'])" }
      ],
      validations: [{ expression: 'false', message: 'The default namespace is reserved for platform-managed resources.' }]
    }
  }
  const facts = toAdmissionFacts([policy], [{ spec: { policyName: 'default-namespace-block' } }])
  const check = (namespace: string) =>
    denialsFor(facts, {
      group: 'postgresql.cnpg.io',
      resource: 'clusters',
      operation: 'CREATE',
      namespaceLabels: { 'kubernetes.io/metadata.name': namespace, 'codemowers.io/sandbox': 'x' }
    })

  expect(facts[0]!.namespaceNames).toEqual({ only: ['default'], except: [] })
  expect(check('sb-78ac58-tyybid')).toEqual([])
  expect(check('default')).toHaveLength(1)
})

it('reads namespace lists and exclusions from matchConditions', () => {
  const policy = (expression: string): RawAdmissionPolicy => ({
    metadata: { name: 'p' },
    spec: { matchConditions: [{ expression }] }
  })
  const [inList] = toAdmissionFacts([policy("request.namespace in ['a', 'b']")], [{ spec: { policyName: 'p' } }])
  const [notIn] = toAdmissionFacts([policy("!(request.namespace in ['kube-system', 'argocd'])")], [{ spec: { policyName: 'p' } }])
  const [ne] = toAdmissionFacts([policy("request.namespace != 'kube-system'")], [{ spec: { policyName: 'p' } }])
  const [other] = toAdmissionFacts([policy("object.metadata.name == 'x'")], [{ spec: { policyName: 'p' } }])

  expect(inList!.namespaceNames).toEqual({ only: ['a', 'b'], except: [] })
  expect(notIn!.namespaceNames).toEqual({ only: null, except: ['kube-system', 'argocd'] })
  expect(ne!.namespaceNames).toEqual({ only: null, except: ['kube-system'] })
  expect(other!.namespaceNames).toEqual({ only: null, except: [] })
})

// Shapes taken from the stateful-workload policies on aws-us-west-2-bravo.
function validating(
  name: string,
  validations: { expression: string; message?: string }[],
  extra: Partial<NonNullable<RawAdmissionPolicy['spec']>> = {},
  annotations?: Record<string, string>
): RawAdmissionPolicy {
  return {
    metadata: { name, annotations },
    spec: {
      matchConstraints: {
        resourceRules: [
          {
            apiGroups: ['postgresql.cnpg.io'],
            apiVersions: ['v1'],
            operations: ['CREATE', 'UPDATE'],
            resources: ['clusters']
          }
        ]
      },
      validations,
      ...extra
    }
  }
}

const CNPG_REPLICAS = validating('cnpg-replicas', [
  {
    expression:
      '!has(object.spec) || !has(object.spec.instances) || (object.spec.instances >= 1 && object.spec.instances <= 2)',
    message: 'spec.instances must be between 1 and 2.'
  }
])

it('reads a policy whose every validation inspects the object as constraining it', () => {
  expect(effectOf(CNPG_REPLICAS)).toBe('constrains')
  expect(
    effectOf(
      validating('cnpg-managed-images', [
        {
          expression:
            '!(has(dyn(object).spec) && has(dyn(object).spec.imagePullPolicy)) || dyn(object).spec.imagePullPolicy == "IfNotPresent"'
        },
        { expression: 'oldObject == null || object.spec.imageName == oldObject.spec.imageName' }
      ])
    )
  ).toBe('constrains')
})

it('follows variables, including chains of them, to the object', () => {
  const viaVariables = validating('via-variables', [{ expression: 'variables.ok' }], {
    variables: [
      { name: 'spec', expression: 'object.spec' },
      { name: 'ok', expression: '!has(variables.spec.instances) || variables.spec.instances <= 2' }
    ]
  })
  const cyclic = validating('cyclic', [{ expression: 'variables.a' }], {
    variables: [
      { name: 'a', expression: 'variables.b' },
      { name: 'b', expression: 'variables.a' }
    ]
  })

  expect(effectOf(viaVariables)).toBe('constrains')
  expect(effectOf(cyclic)).toBe('denies')
})

it('keeps denying when a validation never looks at the object', () => {
  // legacy-stateful-resource-creation: the operation itself is refused.
  expect(effectOf(validating('legacy', [{ expression: 'false' }]))).toBe('denies')
  // default-namespace-block: only the request's namespace decides.
  expect(effectOf(validating('default-block', [{ expression: 'request.namespace != "default"' }]))).toBe(
    'denies'
  )
  // Mixed: one rule can be met, the other cannot.
  expect(
    effectOf(
      validating('mixed', [
        { expression: 'object.spec.instances <= 2' },
        { expression: "has(namespaceObject.metadata.labels['codemowers.io/sandbox'])" }
      ])
    )
  ).toBe('denies')
  expect(effectOf(validating('empty', []))).toBe('denies')
  // A name that merely contains the word is not a reference to it.
  expect(
    effectOf(validating('lookalike', [{ expression: 'request.userInfo.username != "objectstore"' }]))
  ).toBe('denies')
})

it('the annotation overrides the inference in both directions', () => {
  expect(
    effectOf(
      validating(
        'forced',
        CNPG_REPLICAS.spec!.validations as never,
        {},
        { 'codemowers.io/admission-effect': 'denies' }
      )
    )
  ).toBe('denies')
  expect(
    effectOf(
      validating(
        'loosened',
        [{ expression: 'false' }],
        {},
        { 'codemowers.io/admission-effect': 'constrains' }
      )
    )
  ).toBe('constrains')
})

it('reports a constraining policy as a requirement rather than a denial', () => {
  const facts = toAdmissionFacts(
    [CNPG_REPLICAS, validating('legacy', [{ expression: 'false', message: 'Legacy APIs cannot be used.' }])],
    [bindingFor('cnpg-replicas'), bindingFor('legacy')]
  )
  const check = {
    group: 'postgresql.cnpg.io',
    resource: 'clusters',
    operation: 'CREATE' as const,
    namespaceLabels: SANDBOX_SCOPE
  }

  expect(admissionFor(facts, check)).toEqual({
    denials: [{ policy: 'legacy', messages: ['Legacy APIs cannot be used.'] }],
    constraints: [{ policy: 'cnpg-replicas', messages: ['spec.instances must be between 1 and 2.'] }]
  })
  expect(denialsFor(facts, check).map(denial => denial.policy)).toEqual(['legacy'])
})

// legacy-stateful-resource-creation on aws-us-west-2-bravo: only the old EMQX
// API is refused, and only because the policy asks for an Exact match.
function legacyEmqx(matchPolicy?: string): RawAdmissionPolicy {
  return {
    metadata: { name: 'legacy-stateful-resource-creation' },
    spec: {
      matchConstraints: {
        matchPolicy,
        resourceRules: [
          { apiGroups: ['apps.emqx.io'], apiVersions: ['v2alpha1'], operations: ['CREATE'], resources: ['emqxes'] }
        ]
      },
      validations: [{ expression: 'false', message: 'Legacy stateful workload APIs cannot be used for new resources.' }]
    }
  }
}

it('an Exact policy confined to one API version does not deny a create at another', () => {
  const facts = toAdmissionFacts([legacyEmqx('Exact')], [bindingFor('legacy-stateful-resource-creation')])
  const check = (version?: string) => ({
    group: 'apps.emqx.io',
    resource: 'emqxes',
    operation: 'CREATE' as const,
    version,
    namespaceLabels: SANDBOX_SCOPE
  })

  expect(facts[0].guards[0].versions).toEqual(['v2alpha1'])
  expect(denialsFor(facts, check('v2beta1'))).toEqual([])
  expect(denialsFor(facts, check('v2alpha1')).map(denial => denial.policy)).toEqual([
    'legacy-stateful-resource-creation'
  ])
  // Without a version the policy may apply, so it still denies.
  expect(denialsFor(facts, check()).length).toBe(1)
})

it('under the default Equivalent match policy the listed versions do not narrow anything', () => {
  for (const matchPolicy of [undefined, 'Equivalent']) {
    const facts = toAdmissionFacts([legacyEmqx(matchPolicy)], [bindingFor('legacy-stateful-resource-creation')])

    expect(facts[0].guards[0].versions).toBeUndefined()
    expect(
      denialsFor(facts, {
        group: 'apps.emqx.io',
        resource: 'emqxes',
        operation: 'CREATE',
        version: 'v2beta1',
        namespaceLabels: SANDBOX_SCOPE
      }).length
    ).toBe(1)
  }
})
