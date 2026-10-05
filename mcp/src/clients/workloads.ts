import { z } from 'zod'
import type { KubernetesIdentity } from './observability-kubernetes.js'

export const workloadsInput = z.object({
  namespace: z
    .string()
    .max(63)
    .regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/)
    .optional()
})
const names = z.array(z.string()).optional()
const dependencyShape = {
  pods: names,
  images: names,
  configmaps: names,
  secrets: names,
  pvcs: names,
  services: names,
  ingresses: names,
  certificates: names
}

export type Category = keyof typeof dependencyShape
const categories = Object.keys(dependencyShape) as Category[]

const orphanOwner = z.object({
  apiVersion: z.string(),
  uid: z.string(),
  ownerReferenceOnly: z.boolean(),
  ...dependencyShape
})

export const workloadsOutput = z.object({
  workloads: z.array(
    z.object({
      name: z.string(),
      kind: z.string(),
      namespace: z.string(),
      apiVersion: z.string().optional(),
      uid: z.string().optional(),
      ownerReferenceOnly: z.boolean().optional(),
      ...dependencyShape,
      standalonePods: z.array(z.object({ name: z.string(), uid: z.string() })).optional(),
      orphaned: z.record(z.string(), z.record(z.string(), orphanOwner)).optional()
    })
  ),
  warnings: z.array(z.string()).optional(),
  revision: z.string().optional()
})
export type WorkloadInventory = z.infer<typeof workloadsOutput>
type Workload = WorkloadInventory['workloads'][number]
export interface WorkloadListing {
  listWorkloads(
    input: z.input<typeof workloadsInput>,
    identity: KubernetesIdentity
  ): Promise<WorkloadInventory>
}
const ownerSchema = z.object({
  apiVersion: z.string(),
  kind: z.string(),
  name: z.string(),
  uid: z.string(),
  controller: z.boolean().optional()
})

export const objectSchema = z.object({
  metadata: z.object({
    uid: z.string().min(1),
    name: z.string().min(1),
    namespace: z.string().default(''),
    resourceVersion: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    // Allow only markers used by inventory; arbitrary annotations can hold secrets.
    annotations: z
      .object({
        'kubernetes.io/config.mirror': z.string().optional(),
        'reflector.v1.k8s.emberstack.com/reflects': z.string().optional()
      })
      .optional(),
    ownerReferences: z.array(ownerSchema).optional()
  }),
  spec: z.record(z.string(), z.unknown()).optional()
})

type ObjectData = z.infer<typeof objectSchema>
export type Node = ObjectData & { apiVersion: string; kind: string; ownerReferenceOnly?: boolean }
export type Source = {
  apiVersion: string
  kind: string
  resource: string
  category?: Category
  metadataOnly?: boolean
  namespaced?: boolean
}
export const sources: Source[] = [
  { apiVersion: 'v1', kind: 'Pod', resource: 'pods' },
  { apiVersion: 'v1', kind: 'ReplicationController', resource: 'replicationcontrollers' },
  { apiVersion: 'apps/v1', kind: 'Deployment', resource: 'deployments' },
  { apiVersion: 'apps/v1', kind: 'ReplicaSet', resource: 'replicasets' },
  { apiVersion: 'apps/v1', kind: 'StatefulSet', resource: 'statefulsets' },
  { apiVersion: 'apps/v1', kind: 'DaemonSet', resource: 'daemonsets' },
  { apiVersion: 'batch/v1', kind: 'Job', resource: 'jobs' },
  { apiVersion: 'batch/v1', kind: 'CronJob', resource: 'cronjobs' },
  {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    resource: 'persistentvolumeclaims',
    category: 'pvcs',
    metadataOnly: true
  },
  { apiVersion: 'v1', kind: 'ConfigMap', resource: 'configmaps', category: 'configmaps', metadataOnly: true },
  { apiVersion: 'v1', kind: 'Secret', resource: 'secrets', category: 'secrets', metadataOnly: true },
  { apiVersion: 'v1', kind: 'Service', resource: 'services', category: 'services' },
  { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', resource: 'ingresses', category: 'ingresses' }
]

// Optional explicit CR adapter. Other custom-owner kinds are terminal labels
// from ownerReferences and are never listed/watched for ancestry resolution.
export const certificateSource: Source = {
  apiVersion: 'cert-manager.io/v1',
  kind: 'Certificate',
  resource: 'certificates',
  category: 'certificates'
}

// CNPG instances consume certificate and query resources through the API,
// so these references cannot be recovered from Pod volumes alone.
export const cnpgSource: Source = {
  apiVersion: 'postgresql.cnpg.io/v1',
  kind: 'Cluster',
  resource: 'clusters'
}

function cnpgReferences(workload: Workload, spec: Record<string, unknown>): void {
  const certificates = record(spec.certificates)

  for (const field of ['serverTLSSecret', 'serverCASecret', 'clientCASecret', 'replicationTLSSecret'])
    add(workload, 'secrets', certificates[field])

  const monitoring = record(spec.monitoring)

  for (const query of array(monitoring.customQueriesConfigMap)) add(workload, 'configmaps', query.name)
  for (const query of array(monitoring.customQueriesSecret)) add(workload, 'secrets', query.name)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

// Shared controller outputs are dependencies when consumed, but unused copies
// and Helm's release bookkeeping do not represent orphaned application objects.
function omitFromOrphans(item: Node): boolean {
  if (item.kind !== 'Secret' && item.kind !== 'ConfigMap') return false

  const labels = item.metadata.labels ?? {}

  return Boolean(
    (item.kind === 'ConfigMap' && item.metadata.name === 'kube-root-ca.crt') ||
    labels['trust.cert-manager.io/bundle'] ||
    item.metadata.annotations?.['reflector.v1.k8s.emberstack.com/reflects'] ||
    (item.kind === 'Secret' &&
      labels.owner === 'helm' &&
      item.metadata.name.startsWith('sh.helm.release.v1.'))
  )
}

function array(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : []
}

// Reduce built-in specs before caching: no env values, commands, annotations,
// Secret data, or arbitrary custom-resource specs are retained.
export function projectSpec(kind: string, value: unknown): Record<string, unknown> {
  const spec = record(value)
  const pod = (value: unknown) => {
    const input = record(value)
    const references: Workload = { name: '', kind: 'Pod', namespace: '' }

    podReferences(references, input)

    return {
      // Reuse the reference extractor without persisting the original spec.
      containers: (references.images ?? []).map(image => ({ image })),
      volumes: [
        ...(references.configmaps ?? []).map(name => ({ configMap: { name } })),
        ...(references.secrets ?? []).map(secretName => ({ secret: { secretName } })),
        ...(references.pvcs ?? []).map(claimName => ({ persistentVolumeClaim: { claimName } })),
        ...array(input.volumes)
          .filter(volume => volume.ephemeral)
          .map(volume => ({ name: volume.name, ephemeral: {} }))
      ]
    }
  }

  const template = (value: unknown) => {
    const input = record(value)

    return { metadata: { labels: record(record(input.metadata).labels) }, spec: pod(input.spec) }
  }

  if (kind === 'Cluster') {
    const certificates = record(spec.certificates)
    const monitoring = record(spec.monitoring)

    return {
      certificates: Object.fromEntries(
        ['serverTLSSecret', 'serverCASecret', 'clientCASecret', 'replicationTLSSecret']
          .filter(field => typeof certificates[field] === 'string')
          .map(field => [field, certificates[field]])
      ),
      monitoring: {
        customQueriesConfigMap: array(monitoring.customQueriesConfigMap)
          .filter(query => typeof query.name === 'string')
          .map(query => ({ name: query.name })),
        customQueriesSecret: array(monitoring.customQueriesSecret)
          .filter(query => typeof query.name === 'string')
          .map(query => ({ name: query.name }))
      }
    }
  }

  if (kind === 'Certificate') return { secretName: spec.secretName }

  if (kind === 'Pod') return pod(spec)

  if (kind === 'Service') return { selector: record(spec.selector) }

  if (kind === 'Ingress')
    return {
      defaultBackend: { service: { name: record(record(spec.defaultBackend).service).name } },
      rules: array(spec.rules).map(rule => ({
        http: {
          paths: array(record(rule.http).paths).map(path => ({
            backend: { service: { name: record(record(path.backend).service).name } }
          }))
        }
      })),
      tls: array(spec.tls).map(tls => ({ secretName: tls.secretName }))
    }

  if (kind === 'CronJob')
    return { jobTemplate: { spec: { template: template(record(record(spec.jobTemplate).spec).template) } } }

  return {
    template: template(spec.template),
    ...(kind === 'StatefulSet'
      ? {
          serviceName: spec.serviceName,
          volumeClaimTemplates: array(spec.volumeClaimTemplates).map(claim => ({
            metadata: { name: record(claim.metadata).name }
          }))
        }
      : {})
  }
}

function add(workload: Workload, category: Category, value: unknown): void {
  if (typeof value !== 'string' || !value) return

  const values = (workload[category] ??= [])

  if (!values.includes(value)) values.push(value)
}

function owner(node: Node) {
  const refs = node.metadata.ownerReferences ?? []

  return (
    refs.find(ref => ref.controller === true) ??
    (refs.length === 1 && refs[0].controller === undefined ? refs[0] : undefined)
  )
}

function group(apiVersion: string) {
  return apiVersion.includes('/') ? apiVersion.split('/')[0] : ''
}

// Extract references only, never environment values, configuration data or credentials.
function podReferences(workload: Workload, spec: Record<string, unknown>): void {
  for (const container of [
    ...array(spec.containers),
    ...array(spec.initContainers),
    ...array(spec.ephemeralContainers)
  ]) {
    add(workload, 'images', container.image)
    for (const env of array(container.env)) {
      const ref = record(env.valueFrom)

      add(workload, 'configmaps', record(ref.configMapKeyRef).name)
      add(workload, 'secrets', record(ref.secretKeyRef).name)
    }

    for (const env of array(container.envFrom)) {
      add(workload, 'configmaps', record(env.configMapRef).name)
      add(workload, 'secrets', record(env.secretRef).name)
    }
  }

  for (const ref of array(spec.imagePullSecrets)) add(workload, 'secrets', ref.name)
  for (const volume of array(spec.volumes)) {
    add(workload, 'configmaps', record(volume.configMap).name)
    add(workload, 'secrets', record(volume.secret).secretName)
    add(workload, 'pvcs', record(volume.persistentVolumeClaim).claimName)
    for (const ref of array(record(volume.projected).sources)) {
      add(workload, 'configmaps', record(ref.configMap).name)
      add(workload, 'secrets', record(ref.secret).name)
    }

    add(workload, 'secrets', record(record(volume.csi).nodePublishSecretRef).name)
    // In-tree volume plugins that still carry local Secret references.
    for (const plugin of [
      'azureFile',
      'cephfs',
      'cinder',
      'flexVolume',
      'iscsi',
      'rbd',
      'scaleIO',
      'storageos'
    ]) {
      const config = record(volume[plugin])

      add(workload, 'secrets', config.secretName)
      add(workload, 'secrets', record(config.secretRef).name)
    }
  }
}

export function inventory(namespace: string, lists: Map<Source, Node[]>, warnings: Set<string>): Workload[] {
  const nodes = new Map<string, Node>()
  const byUid = new Map<string, Node>()

  for (const items of lists.values()) for (const item of items) byUid.set(item.metadata.uid, item)

  for (const [source, items] of lists)
    if (!source.category) for (const item of items) nodes.set(item.metadata.uid, item)
  // Custom owners need no additional reads. Their verified child objects
  // supply UID/kind/name. Only workload controllers establish custom roots;
  // auxiliary objects join existing workloads or remain namespace orphans.
  const isController = (node: { kind: string; apiVersion: string }) =>
    sources.some(
      source =>
        !source.category && source.kind === node.kind && group(source.apiVersion) === group(node.apiVersion)
    )

  for (const [source, items] of lists) {
    for (const item of items) {
      if (source.category || !isController(item)) continue

      const ref = owner(item)

      if (ref) {
        const builtIn = sources.some(
          source => source.kind === ref.kind && group(source.apiVersion) === group(ref.apiVersion)
        )

        if (ref.kind === 'Certificate' && group(ref.apiVersion) === 'cert-manager.io') continue

        if (!builtIn && !byUid.has(ref.uid)) {
          const terminal: Node = {
            kind: ref.kind,
            apiVersion: ref.apiVersion,
            metadata: { uid: ref.uid, name: ref.name, namespace },
            ownerReferenceOnly: true
          }

          nodes.set(ref.uid, terminal)
          byUid.set(ref.uid, terminal)
        }
      }
    }
  }

  const roots = new Map<string, Workload>()
  const rootByNode = new Map<string, Workload>()
  const labels = new Map<Workload, Record<string, unknown>[]>()

  for (const node of nodes.values()) {
    let root = node
    const chain: Node[] = []
    const seen = new Set<string>()

    while (owner(root) && isController(root)) {
      if (chain.length >= 32) {
        warnings.add(`${namespace}: ownership depth limit reached at ${root.kind}/${root.metadata.name}.`)
        break
      }

      const ref = owner(root)!

      seen.add(root.metadata.uid)
      chain.push(root)

      if (seen.has(ref.uid)) {
        root = chain
          .slice(chain.findIndex(entry => entry.metadata.uid === ref.uid))
          .sort((a, b) => a.metadata.uid.localeCompare(b.metadata.uid))[0]
        warnings.add(`${namespace}: ownership cycle at ${root.kind}/${root.metadata.name}.`)
        break
      }

      const parent = byUid.get(ref.uid)

      if (
        !parent ||
        parent.kind !== ref.kind ||
        parent.metadata.name !== ref.name ||
        group(parent.apiVersion) !== group(ref.apiVersion)
      ) {
        root = {
          apiVersion: ref.apiVersion,
          kind: ref.kind,
          metadata: { uid: ref.uid, name: ref.name, namespace },
          ownerReferenceOnly: true
        }
        warnings.add(
          `${namespace}: ${ref.kind}/${ref.name} is an owner reference only; its existence and further ancestry are unverified.`
        )
        break
      }

      root = parent
    }

    let workload = roots.get(root.metadata.uid)

    if (!workload) {
      workload = {
        name: root.metadata.name,
        kind: root.kind,
        namespace,
        apiVersion: root.apiVersion,
        uid: root.metadata.uid,
        ...(root.ownerReferenceOnly ? { ownerReferenceOnly: true } : {})
      }
      roots.set(root.metadata.uid, workload)
    }

    rootByNode.set(node.metadata.uid, workload)
    let template = record(node.spec?.template)

    if (node.kind === 'CronJob') template = record(record(record(node.spec?.jobTemplate).spec).template)

    const podSpec = node.kind === 'Pod' ? (node.spec ?? {}) : record(template.spec)
    // Old ReplicaSet/Job templates may retain obsolete references. Use live
    // pods and the highest loaded controller template, not revision history.
    const directOwner = owner(node)
    const useTemplate =
      root.metadata.uid === node.metadata.uid || (directOwner && !nodes.has(directOwner.uid))

    if (node.kind === 'Pod' || useTemplate) podReferences(workload, podSpec)

    if (node.kind === 'Cluster' && node.apiVersion === cnpgSource.apiVersion)
      cnpgReferences(workload, node.spec ?? {})

    if (node.kind === 'StatefulSet') add(workload, 'services', node.spec?.serviceName)

    if (node.kind === 'Pod') {
      add(workload, 'pods', node.metadata.name)
      for (const volume of array(podSpec.volumes)) {
        if (volume.ephemeral && typeof volume.name === 'string')
          add(workload, 'pvcs', `${node.metadata.name}-${volume.name}`)
      }
    }

    const labelSets = labels.get(workload) ?? []

    if (node.kind === 'Pod' || useTemplate)
      labelSets.push(
        node.kind === 'Pod' ? (node.metadata.labels ?? {}) : record(record(template.metadata).labels)
      )

    labels.set(workload, labelSets)
  }

  const all = [...roots.values()]
  const orphaned: Workload = {
    name: 'orphaned-workloads',
    kind: 'Namespace',
    namespace,
    apiVersion: 'v1',
    uid: `namespace:${namespace}`
  }
  const services = [...lists]
    .filter(([source]) => source.category === 'services')
    .flatMap(([, items]) => items)

  for (const service of services) {
    const selector = Object.entries(record(service.spec?.selector))

    if (selector.length)
      for (const workload of all) {
        if (labels.get(workload)?.some(set => selector.every(([key, value]) => set[key] === value)))
          add(workload, 'services', service.metadata.name)
      }
  }

  // Retained StatefulSet claims often have no ownerReference. Match only
  // observed PVC names against declared claim templates and numeric ordinals.
  const claims = [...lists].filter(([source]) => source.category === 'pvcs').flatMap(([, items]) => items)

  for (const node of nodes.values())
    if (node.kind === 'StatefulSet') {
      const workload = rootByNode.get(node.metadata.uid)!

      for (const template of array(node.spec?.volumeClaimTemplates)) {
        const name = record(template.metadata).name

        if (typeof name !== 'string') continue

        const prefix = `${name}-${node.metadata.name}-`

        for (const claim of claims)
          if (
            claim.metadata.name.startsWith(prefix) &&
            /^(0|[1-9][0-9]*)$/.test(claim.metadata.name.slice(prefix.length))
          )
            add(workload, 'pvcs', claim.metadata.name)
      }
    }

  // Owned resources (e.g. StatefulSet PVCs) belong to the same root even when
  // their names are not present in a current pod spec.
  const resourceOwners = (item: Node, seen = new Set<string>()): Set<Workload> => {
    const owners = new Set<Workload>()

    if (seen.has(item.metadata.uid)) return owners

    if (seen.size >= 32) {
      warnings.add(`${namespace}: resource ownership depth limit reached.`)

      return owners
    }

    seen.add(item.metadata.uid)
    for (const ref of item.metadata.ownerReferences ?? []) {
      const parent = byUid.get(ref.uid)

      if (
        !parent ||
        parent.kind !== ref.kind ||
        parent.metadata.name !== ref.name ||
        group(parent.apiVersion) !== group(ref.apiVersion)
      )
        continue

      const workload = rootByNode.get(ref.uid) ?? roots.get(ref.uid)

      if (workload) owners.add(workload)
      else for (const ancestor of resourceOwners(parent, new Set(seen))) owners.add(ancestor)
    }

    return owners
  }

  for (const [source, items] of lists) {
    if (!source.category) continue

    for (const item of items)
      for (const workload of resourceOwners(item)) add(workload, source.category, item.metadata.name)
  }

  // Give selectorless/unmatched Services to the namespace bucket before
  // associating Ingresses, so their routes and TLS references stay together.
  for (const service of services)
    if (!all.some(workload => workload.services?.includes(service.metadata.name)))
      add(orphaned, 'services', service.metadata.name)
  const withOrphans = [...all, orphaned]

  for (const [source, items] of lists)
    if (source.category === 'ingresses')
      for (const ingress of items) {
        const spec = ingress.spec ?? {}
        const backends = [
          record(spec.defaultBackend),
          ...array(spec.rules).flatMap(rule =>
            array(record(rule.http).paths).map(path => record(path.backend))
          )
        ]
        const serviceNames = backends.map(backend => record(backend.service).name)
        const targets = withOrphans.filter(
          workload =>
            workload.ingresses?.includes(ingress.metadata.name) ||
            serviceNames.some(name => typeof name === 'string' && workload.services?.includes(name))
        )

        for (const workload of targets.length ? targets : [orphaned]) {
          add(workload, 'ingresses', ingress.metadata.name)
          for (const tls of array(spec.tls)) add(workload, 'secrets', tls.secretName)
        }
      }

  // Certificates are dependencies of workloads consuming their target Secret.
  // Pod references and associated Ingress TLS references already populate
  // workload.secrets, so both paths use the same namespace-local name join.
  const certificates = [...lists]
    .filter(([source]) => source.category === 'certificates')
    .flatMap(([, items]) => items)

  for (const certificate of certificates) {
    const secretName = certificate.spec?.secretName

    if (typeof secretName !== 'string' || !secretName) continue

    for (const workload of withOrphans)
      if (workload.secrets?.includes(secretName)) add(workload, 'certificates', certificate.metadata.name)
  }

  for (const [source, items] of lists) {
    if (!source.category) continue

    for (const item of items)
      if (
        !omitFromOrphans(item) &&
        !withOrphans.some(workload => workload[source.category!]?.includes(item.metadata.name))
      )
        add(orphaned, source.category, item.metadata.name)
  }

  // A Pod with no controller is an unclaimed namespace object.
  for (let index = withOrphans.length - 1; index >= 0; index--) {
    const workload = withOrphans[index]

    if (
      workload.kind !== 'Pod' &&
      !(workload.kind === 'Certificate' && group(workload.apiVersion ?? '') === 'cert-manager.io')
    )
      continue

    const pod = workload.uid ? byUid.get(workload.uid) : undefined

    if (
      workload.kind === 'Pod' &&
      pod?.kind === 'Pod' &&
      workload.uid &&
      !pod?.metadata.ownerReferences?.length &&
      pod?.metadata.annotations?.['kubernetes.io/config.mirror'] === undefined
    ) {
      const pods = (orphaned.standalonePods ??= [])

      pods.push({ name: workload.name, uid: workload.uid })
    }

    for (const category of categories)
      for (const value of workload[category] ?? []) add(orphaned, category, value)
    withOrphans.splice(index, 1)
  }

  orphaned.standalonePods?.sort((a, b) => a.name.localeCompare(b.name))

  // Retain generating-owner relationships within the namespace orphan bucket.
  // Auxiliary CR owners never become workload roots or trigger additional reads.
  for (const [source, items] of lists) {
    if (!source.category) continue

    for (const item of items) {
      if (!orphaned[source.category]?.includes(item.metadata.name)) continue

      for (const ref of item.metadata.ownerReferences ?? []) {
        if (
          sources.some(
            candidate => candidate.kind === ref.kind && group(candidate.apiVersion) === group(ref.apiVersion)
          )
        )
          continue

        const qualifiedKind = `${ref.kind}${group(ref.apiVersion) ? '.' + group(ref.apiVersion) : ''}`
        const groups = (orphaned.orphaned ??= Object.create(null))
        const entries = (groups[qualifiedKind] ??= Object.create(null))
        const parent = byUid.get(ref.uid)
        const verified =
          parent &&
          !parent.ownerReferenceOnly &&
          parent.kind === ref.kind &&
          parent.metadata.name === ref.name &&
          group(parent.apiVersion) === group(ref.apiVersion)
        const entry = (entries[ref.name] ??= {
          apiVersion: ref.apiVersion,
          uid: ref.uid,
          ownerReferenceOnly: !verified
        })
        const values = (entry[source.category] ??= [])

        if (!values.includes(item.metadata.name)) values.push(item.metadata.name)

        values.sort()
      }
    }
  }

  for (const workload of withOrphans) for (const category of categories) workload[category]?.sort()

  return withOrphans
    .filter(workload => workload !== orphaned || categories.some(category => workload[category]?.length))
    .sort((a, b) => `${a.kind}/${a.name}/${a.uid}`.localeCompare(`${b.kind}/${b.name}/${b.uid}`))
}
