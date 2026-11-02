import type { ClusterCapabilitiesDiscovery } from '../clients/cluster-capabilities.js'
import { z } from 'zod'
import { restartResource } from '../domain/workload-actions.js'
import type { KubernetesIdentity } from '../clients/observability-kubernetes.js'

export type CallerRequest = (
  identity: KubernetesIdentity,
  path: string,
  method: 'GET' | 'PATCH' | 'DELETE',
  body?: unknown
) => Promise<string>

const targetShape = {
  namespace: z
    .string()
    .max(63)
    .regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/),
  name: z
    .string()
    .max(253)
    .regex(/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/),
  uid: z.string().min(1).max(253)
}

export const restartWorkloadInput = z
  .object({
    ...targetShape,
    apiVersion: z.enum([
      'apps/v1',
      'postgresql.cnpg.io/v1',
      'cluster.redpanda.com/v1alpha1',
      'cluster.redpanda.com/v1alpha2',
      'dragonflydb.io/v1alpha1'
    ]),
    kind: z.enum(['Deployment', 'StatefulSet', 'DaemonSet', 'Cluster', 'Redpanda', 'Dragonfly'])
  })
  .strict()
export const terminatePodInput = z.object(targetShape).strict()

const resourceSchema = z.object({
  metadata: z.object({
    name: z.string(),
    namespace: z.string(),
    uid: z.string(),
    resourceVersion: z.string(),
    deletionTimestamp: z.string().nullish(),
    ownerReferences: z.array(z.unknown()).optional(),
    annotations: z.record(z.string(), z.string()).optional()
  }),
  spec: z
    .object({
      suspend: z.boolean().optional(),
      clusterSpec: z
        .object({
          statefulset: z
            .object({
              updateStrategy: z.object({ type: z.string().optional() }).optional()
            })
            .optional()
        })
        .optional(),
      paused: z.boolean().optional(),
      updateStrategy: z
        .object({
          type: z.string().optional(),
          rollingUpdate: z.object({ partition: z.number().optional() }).optional()
        })
        .optional()
    })
    .optional()
})

export class WorkloadActions {
  constructor(
    private readonly request: CallerRequest,
    private readonly describeCrd?: ClusterCapabilitiesDiscovery['describeCrd']
  ) {}

  private async target(identity: KubernetesIdentity, path: string, input: z.infer<typeof terminatePodInput>) {
    const current = resourceSchema.parse(JSON.parse(await this.request(identity, path, 'GET')))

    if (
      current.metadata.uid !== input.uid ||
      current.metadata.name !== input.name ||
      current.metadata.namespace !== input.namespace
    )
      throw new Error('Workload identity changed; refresh inventory before trying again')

    if (current.metadata.deletionTimestamp) throw new Error('Object is already terminating')

    return current
  }

  async restart(input: z.infer<typeof restartWorkloadInput>, identity: KubernetesIdentity) {
    const adapter = restartResource(input.apiVersion, input.kind)

    if (!adapter) throw new Error('This workload kind has no supported restart mechanism')

    const path = `${adapter.base}/namespaces/${encodeURIComponent(input.namespace)}/${adapter.resource}/${encodeURIComponent(input.name)}`
    const current = await this.target(identity, path, input)

    if (input.apiVersion === 'apps/v1' && current.metadata.ownerReferences?.length)
      throw new Error('Restart the root workload owner instead of an owned controller')

    if (current.spec?.paused) throw new Error('Deployment is paused; restart would not roll out')

    if (current.spec?.updateStrategy?.type === 'OnDelete')
      throw new Error('OnDelete workloads do not automatically roll out; restart is unsupported')

    if (input.kind === 'StatefulSet' && (current.spec?.updateStrategy?.rollingUpdate?.partition ?? 0) > 0)
      throw new Error('Partitioned StatefulSet rollout would not restart every pod; restart is unsupported')

    if (current.spec?.suspend)
      throw new Error('Operator reconciliation is suspended; restart would not roll out')

    if (current.spec?.clusterSpec?.statefulset?.updateStrategy?.type === 'OnDelete')
      throw new Error('Redpanda OnDelete updates do not automatically roll out; restart is unsupported')

    // Operator versions differ. Confirm that the installed, served CRD exposes
    // the annotation map before sending a patch that could otherwise be pruned.
    if (adapter.crd) {
      if (!this.describeCrd) throw new Error('Operator schema discovery is unavailable')

      const definition = await this.describeCrd(adapter.crd)
      let schema: unknown = definition.versions.find(
        version => version.name === input.apiVersion.split('/')[1]
      )?.schema

      for (const field of adapter.annotationPath) {
        const node = schema as { properties?: Record<string, unknown> } | undefined

        schema = node?.properties?.[field]
      }

      const map = schema as { type?: string; additionalProperties?: { type?: string } } | undefined

      if (map?.type !== 'object' || map.additionalProperties?.type !== 'string')
        throw new Error('Installed operator schema does not support this restart annotation path')
    }

    const requestedAt = new Date().toISOString()
    const annotations = { 'kubectl.kubernetes.io/restartedAt': requestedAt }
    const metadata = { uid: input.uid, resourceVersion: current.metadata.resourceVersion }
    const annotationPatch = adapter.annotationPath.reduceRight<Record<string, unknown>>(
      (value, field) => ({ [field]: value }),
      annotations
    )
    const patch = {
      ...annotationPatch,
      metadata: { ...metadata, ...(annotationPatch.metadata as object | undefined) }
    }

    await this.request(identity, path, 'PATCH', patch)

    return {
      ...input,
      action: 'restart' as const,
      requestedAt,
      status: 'requested' as const,
      message:
        'Restart requested. Controller/operator reconciliation is asynchronous; completion and health are not verified.'
    }
  }

  async terminate(input: z.infer<typeof terminatePodInput>, identity: KubernetesIdentity) {
    const path = `/api/v1/namespaces/${encodeURIComponent(input.namespace)}/pods/${encodeURIComponent(input.name)}`
    const current = await this.target(identity, path, input)

    if (current.metadata.ownerReferences?.length)
      throw new Error('Only standalone pods may be terminated; this pod has an owner')

    if (current.metadata.annotations?.['kubernetes.io/config.mirror'] !== undefined)
      throw new Error('Static mirror pods cannot be terminated through this endpoint')

    await this.request(identity, path, 'DELETE', {
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      preconditions: { uid: input.uid, resourceVersion: current.metadata.resourceVersion }
    })

    return {
      ...input,
      action: 'terminate' as const,
      status: 'requested' as const,
      message:
        'Pod termination requested with its normal grace period. A standalone pod has no controller to recreate it.'
    }
  }
}
