import { describe, expect, it, vi } from 'vitest'
import { createClusterCatalog, storageClassSchema, admissionDescriptionSchema } from './cluster-catalog.js'

describe('cluster catalog', () => {
  it('reads exact description annotations, handles pagination and excludes other metadata', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          metadata: { continue: 'token/+=' },
          items: [
            {
              metadata: {
                name: 'zfs',
                annotations: { 'kubernetes.io/description': 'Local storage', secret: 'hidden' }
              },
              spec: { hidden: true }
            }
          ]
        })
      )
      .mockResolvedValueOnce(JSON.stringify({ items: [{ metadata: { name: 'minio' } }] }))

    const result = await createClusterCatalog(read).listStorageClasses()

    expect(result).toMatchObject({
      storageClasses: [
        { name: 'minio', description: null },
        { name: 'zfs', description: 'Local storage' }
      ]
    })
    expect(result.storageClasses[1]).not.toHaveProperty('metadata')
    expect(result.storageClasses[1]).not.toHaveProperty('spec')
    expect(read.mock.calls[1][0]).toBe(
      '/apis/storage.k8s.io/v1/storageclasses?limit=500&continue=token%2F%2B%3D'
    )
  })

  it('exposes live storage knobs separately from operator guidance', async () => {
    const parameters = {
      fstype: 'zfs',
      recordsize: '32k',
      compression: 'off',
      dedup: 'off',
      poolname: 'offsite/k8s'
    }
    const allowedTopologies = [
      { matchLabelExpressions: [{ key: 'topology.kubernetes.io/zone', values: ['zone-a'] }] }
    ]
    const read = vi.fn().mockResolvedValue(
      JSON.stringify({
        items: [
          {
            metadata: {
              name: 'postgres',
              annotations: {
                'kubernetes.io/description': 'Use Cluster.postgresql.cnpg.io resources.',
                'storageclass.kubernetes.io/is-default-class': 'true',
                'kubectl.kubernetes.io/last-applied-configuration': 'not exposed'
              }
            },
            provisioner: 'zfs.csi.openebs.io',
            parameters,
            reclaimPolicy: 'Retain',
            volumeBindingMode: 'WaitForFirstConsumer',
            allowVolumeExpansion: true,
            mountOptions: ['noatime'],
            allowedTopologies
          }
        ]
      })
    )
    const result = (await createClusterCatalog(read).listStorageClasses()).storageClasses[0]

    expect(result).toEqual({
      name: 'postgres',
      description: 'Use Cluster.postgresql.cnpg.io resources.',
      provisioner: 'zfs.csi.openebs.io',
      filesystemType: 'zfs',
      parameters,
      reclaimPolicy: 'Retain',
      volumeBindingMode: 'WaitForFirstConsumer',
      allowVolumeExpansion: true,
      isDefault: true,
      mountOptions: ['noatime'],
      allowedTopologies
    })
    expect(storageClassSchema.parse(result)).toEqual(result)
  })

  it.each(['fsType', 'fstype', 'csi.storage.k8s.io/fstype'])(
    'normalizes filesystem type from %s',
    async key => {
      const read = vi.fn().mockResolvedValue(
        JSON.stringify({
          items: [
            {
              metadata: { name: 'test' },
              provisioner: 'example.csi',
              parameters: { [key]: 'xfs' }
            }
          ]
        })
      )

      expect((await createClusterCatalog(read).listStorageClasses()).storageClasses[0].filesystemType).toBe(
        'xfs'
      )
    }
  )

  it('preserves unknown filesystem types and absent settings without guessing from descriptions', async () => {
    const read = vi.fn().mockResolvedValue(
      JSON.stringify({
        items: [
          {
            metadata: {
              name: 'minio',
              annotations: { 'kubernetes.io/description': 'ZFS mentioned in prose' }
            },
            provisioner: 'kubernetes.io/no-provisioner'
          }
        ]
      })
    )

    expect((await createClusterCatalog(read).listStorageClasses()).storageClasses[0]).toEqual({
      name: 'minio',
      description: 'ZFS mentioned in prose',
      provisioner: 'kubernetes.io/no-provisioner',
      filesystemType: null,
      parameters: {},
      reclaimPolicy: null,
      volumeBindingMode: null,
      allowVolumeExpansion: false,
      isDefault: false,
      mountOptions: [],
      allowedTopologies: []
    })
  })

  it('supports the legacy default-class annotation and prioritizes explicit CSI filesystem settings', async () => {
    const parameters = { 'csi.storage.k8s.io/fstype': 'ext4', fsType: 'xfs', fstype: 'zfs' }
    const read = vi.fn().mockResolvedValue(
      JSON.stringify({
        items: [
          {
            metadata: {
              name: 'test',
              annotations: { 'storageclass.beta.kubernetes.io/is-default-class': 'true' }
            },
            parameters,
            allowVolumeExpansion: false
          }
        ]
      })
    )

    expect((await createClusterCatalog(read).listStorageClasses()).storageClasses[0]).toMatchObject({
      filesystemType: 'ext4',
      parameters,
      isDefault: true,
      allowVolumeExpansion: false
    })
  })

  it('discovers both policy types across served API versions', async () => {
    const read = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/apis/admissionregistration.k8s.io')
        return JSON.stringify({ versions: [{ version: 'v1' }, { version: 'v1beta1' }] })

      if (path.endsWith('/v1'))
        return JSON.stringify({ resources: [{ name: 'validatingadmissionpolicies', verbs: ['list'] }] })

      if (path.endsWith('/v1beta1'))
        return JSON.stringify({ resources: [{ name: 'mutatingadmissionpolicies', verbs: ['list'] }] })

      return JSON.stringify({
        items: [
          {
            metadata: {
              name: 'policy',
              annotations: { 'kubernetes.io/description': 'Description from cluster' }
            },
            spec: {}
          }
        ]
      })
    })

    expect(await createClusterCatalog(read).listAdmissionPolicies()).toMatchObject({
      policies: [
        { kind: 'ValidatingAdmissionPolicy', name: 'policy', description: 'Description from cluster' },
        { kind: 'MutatingAdmissionPolicy', name: 'policy', description: 'Description from cluster' }
      ],
      unavailableKinds: []
    })
    expect(read).toHaveBeenCalledWith(
      '/apis/admissionregistration.k8s.io/v1beta1/mutatingadmissionpolicies?limit=500'
    )
  })

  it('preserves policy settings and joins bindings by kind and policyName', async () => {
    const specs = {
      validatingadmissionpolicies: {
        failurePolicy: 'Fail',
        paramKind: { apiVersion: 'v1', kind: 'ConfigMap' },
        matchConstraints: {
          resourceRules: [
            { apiGroups: ['apps'], apiVersions: ['v1'], operations: ['CREATE'], resources: ['deployments'] }
          ]
        },
        matchConditions: [{ name: 'has-spec', expression: 'has(object.spec)' }],
        variables: [{ name: 'replicas', expression: 'object.spec.replicas' }],
        validations: [
          { expression: 'variables.replicas > 0', message: 'Positive replicas required', reason: 'Invalid' }
        ],
        auditAnnotations: [{ key: 'checked', valueExpression: '"true"' }]
      },
      mutatingadmissionpolicies: {
        failurePolicy: 'Ignore',
        reinvocationPolicy: 'IfNeeded',
        mutations: [
          {
            patchType: 'JSONPatch',
            jsonPatch: { expression: '[JSONPatch{op: "add", path: "/spec/replicas", value: 3}]' }
          }
        ]
      }
    }
    const bindingSpecs = {
      validatingadmissionpolicybindings: {
        policyName: 'shared-name',
        validationActions: ['Deny', 'Audit'],
        matchResources: { namespaceSelector: { matchLabels: { team: 'a' } } },
        paramRef: { name: 'limits', namespace: 'platform', parameterNotFoundAction: 'Deny' }
      },
      mutatingadmissionpolicybindings: { policyName: 'shared-name' }
    }
    const allSpecs: Record<string, object> = { ...specs, ...bindingSpecs }
    const read = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/apis/admissionregistration.k8s.io')
        return JSON.stringify({ versions: [{ version: 'v1' }] })

      if (path.endsWith('/v1'))
        return JSON.stringify({ resources: Object.keys(allSpecs).map(name => ({ name, verbs: ['list'] })) })

      const resource = path.split('/').at(-1)!.split('?')[0]
      const items = [
        {
          metadata: { name: resource.endsWith('bindings') ? `${resource}-binding` : 'shared-name' },
          spec: allSpecs[resource]
        }
      ]

      if (resource.endsWith('bindings'))
        items.push({ metadata: { name: 'unrelated' }, spec: { policyName: 'other' } })

      return JSON.stringify({ items })
    })
    const { policies } = await createClusterCatalog(read).listAdmissionPolicies()

    expect(policies).toHaveLength(2)
    expect(policies[0]).toMatchObject({
      name: 'shared-name',
      kind: 'ValidatingAdmissionPolicy',
      apiVersion: 'admissionregistration.k8s.io/v1',
      spec: specs.validatingadmissionpolicies,
      bindings: [
        { kind: 'ValidatingAdmissionPolicyBinding', spec: bindingSpecs.validatingadmissionpolicybindings }
      ]
    })
    expect(policies[1]).toMatchObject({
      kind: 'MutatingAdmissionPolicy',
      spec: specs.mutatingadmissionpolicies,
      bindings: [
        { kind: 'MutatingAdmissionPolicyBinding', spec: bindingSpecs.mutatingadmissionpolicybindings }
      ]
    })
    for (const policy of policies) {
      expect(policy.bindings).toHaveLength(1)
      expect(admissionDescriptionSchema.parse(policy)).toEqual(policy)
    }

    expect(read.mock.calls.every(([path]) => path.startsWith('/apis/admissionregistration.k8s.io'))).toBe(
      true
    )
  })

  it.each([true, false])(
    'distinguishes unbound policies from unavailable binding APIs (available: %s)',
    async available => {
      const read = vi.fn().mockImplementation(async (path: string) => {
        if (path === '/apis/admissionregistration.k8s.io')
          return JSON.stringify({ versions: [{ version: 'v1' }] })

        if (path.endsWith('/v1'))
          return JSON.stringify({
            resources: [
              { name: 'validatingadmissionpolicies', verbs: ['list'] },
              ...(available ? [{ name: 'validatingadmissionpolicybindings', verbs: ['list'] }] : [])
            ]
          })

        return JSON.stringify({
          items: path.includes('bindings') ? [] : [{ metadata: { name: 'unbound' }, spec: {} }]
        })
      })
      const result = await createClusterCatalog(read).listAdmissionPolicies()

      expect(result.policies[0].bindings).toEqual(available ? [] : null)
    }
  )

  it('does not turn denied binding reads into an unbound policy', async () => {
    const read = vi.fn().mockImplementation(async (path: string) => {
      if (path === '/apis/admissionregistration.k8s.io')
        return JSON.stringify({ versions: [{ version: 'v1' }] })

      if (path.endsWith('/v1'))
        return JSON.stringify({
          resources: [
            { name: 'validatingadmissionpolicies', verbs: ['list'] },
            { name: 'validatingadmissionpolicybindings', verbs: ['list'] }
          ]
        })

      throw new Error('Kubernetes API returned HTTP 403')
    })

    await expect(createClusterCatalog(read).listAdmissionPolicies()).rejects.toThrow('403')
  })

  it('reports unavailable APIs separately from an empty policy list', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ versions: [{ version: 'v1' }] }))
      .mockResolvedValueOnce(JSON.stringify({ resources: [] }))

    expect(await createClusterCatalog(read).listAdmissionPolicies()).toEqual({
      policies: [],
      unavailableKinds: ['ValidatingAdmissionPolicy', 'MutatingAdmissionPolicy']
    })
  })

  it('propagates API errors instead of reporting empty catalogs', async () => {
    const read = vi.fn().mockRejectedValue(new Error('Kubernetes API returned HTTP 403'))

    await expect(createClusterCatalog(read).listStorageClasses()).rejects.toThrow('403')
    await expect(createClusterCatalog(read).listAdmissionPolicies()).rejects.toThrow('403')
  })

  it('does not cache descriptions between requests', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ items: [{ metadata: { name: 'minio' } }] }))
      .mockResolvedValueOnce(
        JSON.stringify({
          items: [
            { metadata: { name: 'minio', annotations: { 'kubernetes.io/description': 'Use Bucket CR' } } }
          ]
        })
      )
    const catalog = createClusterCatalog(read)

    await catalog.listStorageClasses()
    expect((await catalog.listStorageClasses()).storageClasses[0].description).toBe('Use Bucket CR')
  })
})
