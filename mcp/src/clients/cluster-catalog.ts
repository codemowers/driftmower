import { z } from 'zod'
import { admissionSpecSchema, admissionBindingSpecSchema } from './admission-policy-schemas.js'

export const namedDescriptionSchema = z.object({ name: z.string(), description: z.string().nullable() })
const topologySchema = z.object({
  matchLabelExpressions: z.array(z.object({ key: z.string(), values: z.array(z.string()) }))
})

export const storageClassSchema = namedDescriptionSchema.extend({
  provisioner: z.string().nullable(),
  filesystemType: z.string().nullable(),
  parameters: z.record(z.string(), z.string()),
  reclaimPolicy: z.string().nullable(),
  volumeBindingMode: z.string().nullable(),
  allowVolumeExpansion: z.boolean(),
  isDefault: z.boolean(),
  mountOptions: z.array(z.string()),
  allowedTopologies: z.array(topologySchema)
})
export const policyKindSchema = z.enum(['ValidatingAdmissionPolicy', 'MutatingAdmissionPolicy'])
export const admissionBindingSchema = namedDescriptionSchema.extend({
  kind: z.enum(['ValidatingAdmissionPolicyBinding', 'MutatingAdmissionPolicyBinding']),
  apiVersion: z.string(),
  spec: admissionBindingSpecSchema
})
export const admissionDescriptionSchema = namedDescriptionSchema.extend({
  kind: policyKindSchema,
  apiVersion: z.string(),
  // A policy author may annotate intent (see EFFECT_ANNOTATION in the
  // provisioning facts); the raw map is passed on for that.
  annotations: z.record(z.string(), z.string()),
  spec: admissionSpecSchema,
  // null means the binding API is unavailable, [] means it was read and no
  // bindings reference this policy. Authorization/API errors are never hidden.
  bindings: z.array(admissionBindingSchema).nullable()
})

export interface ClusterCatalog {
  listStorageClasses(): Promise<{ storageClasses: z.infer<typeof storageClassSchema>[] }>
  listAdmissionPolicies(): Promise<{
    policies: z.infer<typeof admissionDescriptionSchema>[]
    unavailableKinds: z.infer<typeof policyKindSchema>[]
  }>
}

const listSchema = z.object({
  metadata: z.object({ continue: z.string().optional() }).optional(),
  items: z.array(z.unknown())
})
const resourceSchema = z.object({
  metadata: z.object({ name: z.string(), annotations: z.record(z.string(), z.string()).optional() })
})
const storageResourceSchema = resourceSchema.extend({
  provisioner: z.string().optional(),
  parameters: z.record(z.string(), z.string()).nullish(),
  reclaimPolicy: z.string().optional(),
  volumeBindingMode: z.string().optional(),
  allowVolumeExpansion: z.boolean().nullish(),
  mountOptions: z.array(z.string()).nullish(),
  allowedTopologies: z.array(topologySchema).nullish()
})
const groupSchema = z.object({ versions: z.array(z.object({ version: z.string() })) })
const discoverySchema = z.object({
  resources: z.array(z.object({ name: z.string(), verbs: z.array(z.string()) }))
})
const policyResources = [
  {
    name: 'validatingadmissionpolicies',
    kind: 'ValidatingAdmissionPolicy',
    bindingName: 'validatingadmissionpolicybindings',
    bindingKind: 'ValidatingAdmissionPolicyBinding'
  },
  {
    name: 'mutatingadmissionpolicies',
    kind: 'MutatingAdmissionPolicy',
    bindingName: 'mutatingadmissionpolicybindings',
    bindingKind: 'MutatingAdmissionPolicyBinding'
  }
] as const

function describeResource(input: unknown): z.infer<typeof namedDescriptionSchema> {
  const resource = resourceSchema.parse(input)

  return {
    name: resource.metadata.name,
    description: resource.metadata.annotations?.['kubernetes.io/description'] ?? null
  }
}

function describeStorageClass(input: unknown): z.infer<typeof storageClassSchema> {
  const resource = storageResourceSchema.parse(input)
  const parameters = resource.parameters ?? {}
  const annotations = resource.metadata.annotations ?? {}

  return {
    ...describeResource(resource),
    provisioner: resource.provisioner ?? null,
    filesystemType: parameters['csi.storage.k8s.io/fstype'] ?? parameters.fsType ?? parameters.fstype ?? null,
    parameters,
    reclaimPolicy: resource.reclaimPolicy ?? null,
    volumeBindingMode: resource.volumeBindingMode ?? null,
    allowVolumeExpansion: resource.allowVolumeExpansion === true,
    isDefault:
      annotations['storageclass.kubernetes.io/is-default-class'] === 'true' ||
      annotations['storageclass.beta.kubernetes.io/is-default-class'] === 'true',
    mountOptions: resource.mountOptions ?? [],
    allowedTopologies: resource.allowedTopologies ?? []
  }
}

// Expose settings directly from the API rather than inferring them from prose.
// Unrelated annotations and referenced parameter objects are not returned.
export function createClusterCatalog(read: (path: string) => Promise<string>): ClusterCatalog {
  async function list<T extends { name: string }>(
    path: string,
    project: (input: unknown) => T
  ): Promise<T[]> {
    const results: T[] = []
    let continuation = ''

    for (let page = 0; page < 20; page += 1) {
      const parameters = new URLSearchParams({ limit: '500' })

      if (continuation) parameters.set('continue', continuation)

      const result = listSchema.parse(JSON.parse(await read(`${path}?${parameters}`)))

      results.push(...result.items.map(project))
      continuation = result.metadata?.continue ?? ''

      if (!continuation) return results.sort((a, b) => a.name.localeCompare(b.name))
    }

    throw new Error('Cluster catalog exceeds 20 pages; refusing to return an incomplete list')
  }

  return {
    async listStorageClasses() {
      return { storageClasses: await list('/apis/storage.k8s.io/v1/storageclasses', describeStorageClass) }
    },
    async listAdmissionPolicies() {
      const groupPath = '/apis/admissionregistration.k8s.io'
      const group = groupSchema.parse(JSON.parse(await read(groupPath)))
      const paths = new Map<string, string>()
      const resourceNames = policyResources.flatMap(resource => [resource.name, resource.bindingName])

      // Prefer stable APIs, but support clusters serving policies in beta/alpha.
      for (const version of ['v1', 'v1beta1', 'v1alpha1']) {
        if (!group.versions.some(candidate => candidate.version === version)) continue

        const discovery = discoverySchema.parse(JSON.parse(await read(`${groupPath}/${version}`)))

        for (const name of resourceNames) {
          if (
            !paths.has(name) &&
            discovery.resources.some(candidate => candidate.name === name && candidate.verbs.includes('list'))
          ) {
            paths.set(name, `${groupPath}/${version}/${name}`)
          }
        }

        if (paths.size === resourceNames.length) break
      }

      const policies: z.infer<typeof admissionDescriptionSchema>[] = []
      const unavailableKinds: z.infer<typeof policyKindSchema>[] = []

      for (const resource of policyResources) {
        const path = paths.get(resource.name)

        if (!path) {
          unavailableKinds.push(resource.kind)
          continue
        }

        const bindingPath = paths.get(resource.bindingName)
        const bindings = bindingPath
          ? await list(bindingPath, input => {
              const item = resourceSchema.extend({ spec: admissionBindingSpecSchema }).parse(input)

              return {
                ...describeResource(item),
                kind: resource.bindingKind,
                apiVersion: bindingPath.split('/').slice(2, 4).join('/'),
                spec: item.spec
              }
            })
          : null

        policies.push(
          ...(await list(path, input => {
            const item = resourceSchema.extend({ spec: admissionSpecSchema }).parse(input)

            return {
              ...describeResource(item),
              kind: resource.kind,
              apiVersion: path.split('/').slice(2, 4).join('/'),
              annotations: item.metadata.annotations ?? {},
              spec: item.spec,
              bindings: bindings?.filter(binding => binding.spec.policyName === item.metadata.name) ?? null
            }
          }))
        )
      }

      return { policies, unavailableKinds }
    }
  }
}
