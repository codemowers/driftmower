import { describe, expect, it } from 'vitest'
import {
  certificateSource,
  cnpgSource,
  inventory,
  objectSchema,
  projectSpec,
  sources,
  workloadsOutput,
  type Node,
  type Source
} from './workloads.js'

const owner = (kind: string, name: string, apiVersion = 'apps/v1', uid = `${kind}/${name}`) => ({
  kind,
  name,
  apiVersion,
  uid,
  controller: true
})

function node(
  kind: string,
  name: string,
  spec = {},
  owners: ReturnType<typeof owner>[] = [],
  labels = {}
): Node {
  const source = sources.find(source => source.kind === kind)

  return {
    kind,
    apiVersion: source?.apiVersion ?? 'postgresql.cnpg.io/v1',
    metadata: { name, uid: `${kind}/${name}`, namespace: 'team', ownerReferences: owners, labels },
    spec
  }
}

function graph(nodes: Node[]) {
  const lists = new Map<Source, Node[]>()

  for (const item of nodes) {
    const source = sources.find(source => source.kind === item.kind) ??
      (item.kind === 'Certificate'
        ? certificateSource
        : item.kind === 'Cluster' && item.apiVersion === cnpgSource.apiVersion
          ? cnpgSource
          : undefined) ?? {
        apiVersion: item.apiVersion,
        kind: item.kind,
        resource: 'clusters',
        metadataOnly: true
      }
    const items = lists.get(source) ?? []

    items.push(item)
    lists.set(source, items)
  }

  const warnings = new Set<string>()
  const workloads = inventory('team', lists, warnings)

  return { workloads, warnings: [...warnings] }
}

describe('workload ownership graph', () => {
  it('omits empty namespace pseudo-owners', () => {
    expect(graph([]).workloads).toEqual([])
    expect(graph([node('Deployment', 'app')]).workloads.map(item => item.kind)).toEqual(['Deployment'])
  })

  it('resolves operator ancestry and joins references, selectors and routes', () => {
    const result = graph([
      node('Cluster', 'database'),
      node('StatefulSet', 'db', {}, [owner('Cluster', 'database', 'postgresql.cnpg.io/v1')]),
      node(
        'Pod',
        'db-0',
        {
          containers: [{ image: 'db:1', envFrom: [{ configMapRef: { name: 'config' } }] }],
          volumes: [{ persistentVolumeClaim: { claimName: 'data' } }]
        },
        [owner('StatefulSet', 'db')],
        { app: 'db' }
      ),
      node('Service', 'db', { selector: { app: 'db' } }),
      node('Ingress', 'db-route', {
        defaultBackend: { service: { name: 'db' } },
        tls: [{ secretName: 'tls' }]
      }),
      node('ConfigMap', 'config'),
      node('ConfigMap', 'unused'),
      node('Secret', 'tls'),
      node('Secret', 'unused-secret'),
      node('PersistentVolumeClaim', 'data')
    ])

    expect(workloadsOutput.parse(result)).toEqual(result)
    expect(result.workloads.find(item => item.kind === 'Cluster')).toMatchObject({
      name: 'database',
      apiVersion: 'postgresql.cnpg.io/v1',
      uid: 'Cluster/database',
      pods: ['db-0'],
      images: ['db:1'],
      configmaps: ['config'],
      secrets: ['tls'],
      pvcs: ['data'],
      services: ['db'],
      ingresses: ['db-route']
    })
    expect(result.workloads.find(item => item.kind === 'Namespace')).toMatchObject({
      configmaps: ['unused'],
      secrets: ['unused-secret']
    })
    expect(result.warnings).toEqual([])
  })
  it('puts standalone pods under the namespace and includes scaled-to-zero workloads', () => {
    const result = graph([
      node('Pod', 'standalone', { containers: [{ image: 'one:1' }] }),
      node('Deployment', 'zero', { template: { spec: { containers: [{ image: 'two:1' }] } } })
    ])

    expect(result.workloads.find(item => item.kind === 'Namespace')).toMatchObject({
      pods: ['standalone'],
      images: ['one:1'],
      standalonePods: [{ name: 'standalone', uid: 'Pod/standalone' }]
    })
    expect(result.workloads.find(item => item.kind === 'Deployment')).toMatchObject({
      name: 'zero',
      images: ['two:1']
    })
  })
  it('does not offer termination for static mirror pods', () => {
    const mirror = node('Pod', 'static')

    mirror.metadata.annotations = { 'kubernetes.io/config.mirror': 'mirror-hash' }
    const result = graph([mirror])

    expect(result.workloads[0].pods).toEqual(['static'])
    expect(result.workloads[0].standalonePods).toBeUndefined()
  })
  it('does not bind dangling UIDs to same-name replacements and terminates cycles', () => {
    const result = graph([
      node('Pod', 'old', {}, [owner('Deployment', 'app', 'apps/v1', 'deleted')]),
      node('Deployment', 'app'),
      node('Deployment', 'a', {}, [owner('Deployment', 'b')]),
      node('Deployment', 'b', {}, [owner('Deployment', 'a')])
    ])

    expect(result.workloads.filter(item => item.name === 'app')).toHaveLength(2)
    expect(result.workloads.filter(item => ['a', 'b'].includes(item.name))).toHaveLength(1)
    expect(result.warnings.some(warning => warning.includes('cycle'))).toBe(true)
    expect(result.warnings.some(warning => warning.includes('unverified'))).toBe(true)
  })
  it('keeps auxiliary custom owners in the namespace bucket', () => {
    const result = graph([
      node('Secret', 'mat-secrets', {}, [
        owner('StringSecret', 'mat-secrets', 'secretgenerator.mittwald.de/v1alpha1')
      ]),
      node('Deployment', 'app'),
      node('Pod', 'app-0', { volumes: [{ secret: { secretName: 'consumed-secret' } }] }, [
        owner('Deployment', 'app')
      ]),
      node('Secret', 'consumed-secret', {}, [
        owner('StringSecret', 'consumed-secret', 'secretgenerator.mittwald.de/v1alpha1')
      ])
    ])

    expect(result.workloads.some(item => item.kind === 'StringSecret')).toBe(false)
    expect(result.workloads.find(item => item.kind === 'Namespace')).toMatchObject({
      secrets: ['mat-secrets'],
      orphaned: {
        'StringSecret.secretgenerator.mittwald.de': {
          'mat-secrets': {
            apiVersion: 'secretgenerator.mittwald.de/v1alpha1',
            uid: 'StringSecret/mat-secrets',
            ownerReferenceOnly: true,
            secrets: ['mat-secrets']
          }
        }
      }
    })
    expect(workloadsOutput.parse(result)).toEqual(result)
    expect(result.workloads.find(item => item.kind === 'Deployment')).toMatchObject({
      secrets: ['consumed-secret']
    })
  })
  it('follows indirect ownership of auxiliary resources', () => {
    const result = graph([
      node('Deployment', 'app'),
      node('Secret', 'owned-secret', {}, [owner('Deployment', 'app')]),
      node('ConfigMap', 'owned-config', {}, [owner('Secret', 'owned-secret', 'v1')])
    ])

    expect(result.workloads.find(item => item.kind === 'Deployment')).toMatchObject({
      secrets: ['owned-secret'],
      configmaps: ['owned-config']
    })
  })
  it('associates Certificates with workloads using their Secrets directly or through Ingress TLS', () => {
    const direct = {
      ...node('Certificate', 'direct-cert', { secretName: 'direct-tls' }),
      apiVersion: 'cert-manager.io/v1'
    }
    const ingress = {
      ...node('Certificate', 'ingress-cert', { secretName: 'ingress-tls' }),
      apiVersion: 'cert-manager.io/v1'
    }
    const result = graph([
      direct,
      ingress,
      node('Deployment', 'app'),
      node(
        'Pod',
        'app-0',
        { volumes: [{ secret: { secretName: 'direct-tls' } }] },
        [owner('Deployment', 'app')],
        { app: 'app' }
      ),
      node('Service', 'app', { selector: { app: 'app' } }),
      node('Ingress', 'app-route', {
        defaultBackend: { service: { name: 'app' } },
        tls: [{ secretName: 'ingress-tls' }]
      }),
      node('Secret', 'direct-tls'),
      node('Secret', 'ingress-tls')
    ])

    expect(result.workloads.find(item => item.kind === 'Deployment')).toMatchObject({
      pods: ['app-0'],
      ingresses: ['app-route'],
      certificates: ['direct-cert', 'ingress-cert']
    })
    expect(result.workloads.some(item => item.kind === 'Certificate')).toBe(false)
    expect(result.workloads.find(item => item.kind === 'Namespace')?.certificates).toBeUndefined()
  })
  it('does not traverse a second custom owner layer', () => {
    const cluster = node('Cluster', 'database', {}, [owner('Application', 'parent', 'custom.example/v1')])
    const result = graph([
      cluster,
      node('Pod', 'db-0', {}, [owner('Cluster', 'database', 'postgresql.cnpg.io/v1')])
    ])

    expect(result.workloads.find(item => item.kind === 'Cluster')).toMatchObject({ pods: ['db-0'] })
    expect(result.workloads.some(item => item.kind === 'Application')).toBe(false)
  })
  it('projects specs to references and images without retaining plaintext values', () => {
    const projected = projectSpec('Pod', {
      containers: [
        {
          image: 'app:1',
          command: ['sensitive-command'],
          env: [
            { name: 'PASSWORD', value: 'sensitive-value' },
            { valueFrom: { secretKeyRef: { name: 'credentials' } } }
          ]
        }
      ]
    })

    expect(JSON.stringify(projected)).not.toContain('sensitive')
    expect(JSON.stringify(projected)).toContain('credentials')
    expect(JSON.stringify(projected)).toContain('app:1')
  })
})

describe('shared generated resources', () => {
  function reflected(kind: string, name: string) {
    const item = node(kind, name)

    item.metadata.annotations = { 'reflector.v1.k8s.emberstack.com/reflects': `registry/${name}` }

    return item
  }

  const shared = () => [
    reflected('Secret', 'zot-registry-cluster-pull'),
    reflected('ConfigMap', 'shared-config'),
    node('Secret', 'trusted-ca-certs', {}, [], { 'trust.cert-manager.io/bundle': 'trusted-ca-certs' }),
    node('ConfigMap', 'trusted-ca-certs', {}, [], { 'trust.cert-manager.io/bundle': 'trusted-ca-certs' }),
    node('ConfigMap', 'kube-root-ca.crt'),
    node('Secret', 'sh.helm.release.v1.checkers.v73', {}, [], { owner: 'helm' })
  ]

  it('omits unused trust bundles, reflected copies and Helm release records from namespace orphans', () => {
    expect(graph(shared()).workloads).toEqual([])
  })

  it('retains generated objects when a workload consumes them', () => {
    const result = graph([
      node('Deployment', 'app', {
        template: {
          spec: {
            imagePullSecrets: [{ name: 'zot-registry-cluster-pull' }],
            volumes: [
              { name: 'trust', configMap: { name: 'trusted-ca-certs' } },
              { name: 'config', configMap: { name: 'shared-config' } },
              { name: 'api-ca', configMap: { name: 'kube-root-ca.crt' } },
              { name: 'secret', secret: { secretName: 'trusted-ca-certs' } }
            ]
          }
        }
      }),
      ...shared()
    ])

    expect(result.workloads).toHaveLength(1)
    expect(result.workloads[0].secrets).toEqual(['trusted-ca-certs', 'zot-registry-cluster-pull'])
    expect(result.workloads[0].configmaps).toEqual(['kube-root-ca.crt', 'shared-config', 'trusted-ca-certs'])
  })

  it('preserves unmarked objects and application resources managed by Helm or cert-manager', () => {
    const result = graph([
      node('Secret', 'zot-registry-cluster-pull'),
      node('Secret', 'sh.helm.release.v1.fake.v1'),
      node('Secret', 'app', {}, [], { owner: 'helm' }),
      node('Secret', 'tls', {}, [], { 'controller.cert-manager.io/fao': 'true' }),
      node('ConfigMap', 'app', {}, [], { 'app.kubernetes.io/managed-by': 'Helm' })
    ])

    expect(result.workloads[0].secrets).toEqual([
      'app',
      'sh.helm.release.v1.fake.v1',
      'tls',
      'zot-registry-cluster-pull'
    ])
    expect(result.workloads[0].configmaps).toEqual(['app'])
  })

  it('retains the reflection marker while discarding unrelated annotations', () => {
    const parsed = objectSchema.parse({
      metadata: {
        name: 'mirror',
        uid: 'mirror',
        annotations: {
          'reflector.v1.k8s.emberstack.com/reflects': 'registry/source',
          'kubectl.kubernetes.io/last-applied-configuration': 'sensitive',
          arbitrary: 'sensitive'
        }
      }
    })

    expect(parsed.metadata.annotations).toEqual({
      'reflector.v1.k8s.emberstack.com/reflects': 'registry/source'
    })
  })
})

it('associates CNPG API-read TLS and query resources, then joins the provisioning Certificate', () => {
  const result = graph([
    node('Cluster', 'database', {
      certificates: {
        serverTLSSecret: 'database-tls',
        serverCASecret: 'database-tls',
        clientCASecret: 'client-ca',
        replicationTLSSecret: 'replication-tls'
      },
      monitoring: {
        customQueriesConfigMap: [{ name: 'cnpg-default-monitoring', key: 'queries' }],
        customQueriesSecret: [{ name: 'private-queries', key: 'queries' }]
      }
    }),
    node('Pod', 'database-1', {}, [owner('Cluster', 'database', cnpgSource.apiVersion)]),
    { ...node('Certificate', 'database', { secretName: 'database-tls' }), apiVersion: 'cert-manager.io/v1' },
    node('Secret', 'database-tls'),
    node('ConfigMap', 'cnpg-default-monitoring')
  ])

  expect(result.workloads).toHaveLength(1)
  expect(result.workloads[0]).toMatchObject({
    kind: 'Cluster',
    name: 'database',
    pods: ['database-1'],
    secrets: ['client-ca', 'database-tls', 'private-queries', 'replication-tls'],
    configmaps: ['cnpg-default-monitoring'],
    certificates: ['database']
  })
  expect(result.workloads[0].ownerReferenceOnly).toBeUndefined()
})

it('retains only explicit CNPG TLS/query reference names when projecting its spec', () => {
  expect(
    projectSpec('Cluster', {
      certificates: { serverTLSSecret: 'tls', extra: 'sensitive' },
      monitoring: { customQueriesConfigMap: [{ name: 'queries', key: 'sql', extra: 'sensitive' }] },
      bootstrap: { initdb: { password: 'sensitive' } },
      postgresql: { parameters: { custom: 'sensitive' } }
    })
  ).toEqual({
    certificates: { serverTLSSecret: 'tls' },
    monitoring: { customQueriesConfigMap: [{ name: 'queries' }], customQueriesSecret: [] }
  })
})
