import { z } from 'zod'
import { collect } from '../clients/kubernetes-list.js'
import type { KubernetesReader, ObservabilityKubernetes } from '../clients/observability-kubernetes.js'
import type { HttpRequester } from '../clients/observability-http.js'
import type { ObservabilityCaller } from './observability-service.js'
import type { CallerBudget } from '../clients/backend-guard.js'

export const volumesInput = z
  .object({
    namespace: z
      .string()
      .max(63)
      .regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/)
      .optional(),
    includeUnboundPVs: z.boolean().default(false)
  })
  .strict()
const metadata = z.object({ name: z.string(), namespace: z.string().optional() })
const pvc = z.object({
  metadata,
  spec: z.object({
    volumeName: z.string().optional(),
    storageClassName: z.string().optional(),
    volumeMode: z.string().optional(),
    accessModes: z.array(z.string()).optional(),
    resources: z.object({ requests: z.object({ storage: z.string().optional() }).optional() }).optional()
  }),
  status: z
    .object({
      phase: z.string().optional(),
      capacity: z.object({ storage: z.string().optional() }).optional()
    })
    .optional()
})
const pv = z.object({
  metadata,
  spec: z.object({
    storageClassName: z.string().optional(),
    volumeMode: z.string().optional(),
    accessModes: z.array(z.string()).optional(),
    capacity: z.object({ storage: z.string().optional() }).optional(),
    persistentVolumeReclaimPolicy: z.string().optional(),
    csi: z.object({ driver: z.string() }).optional(),
    claimRef: z.object({ namespace: z.string(), name: z.string() }).optional()
  }),
  status: z.object({ phase: z.string().optional() }).optional()
})

function describePv(item: z.infer<typeof pv>) {
  return {
    name: item.metadata.name,
    phase: item.status?.phase ?? null,
    capacityStorage: item.spec.capacity?.storage ?? null,
    storageClass: item.spec.storageClassName ?? null,
    volumeMode: item.spec.volumeMode ?? 'Filesystem',
    accessModes: item.spec.accessModes ?? [],
    reclaimPolicy: item.spec.persistentVolumeReclaimPolicy ?? null,
    csiDriver: item.spec.csi?.driver ?? null,
    claim: item.spec.claimRef ?? null
  }
}

const sample = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('vector'),
    result: z.array(
      z.object({ metric: z.record(z.string(), z.string()), value: z.tuple([z.number(), z.string()]) })
    )
  }),
  warnings: z.array(z.string()).optional()
})
const metrics = {
  usedBytes: 'kubelet_volume_stats_used_bytes',
  capacityBytes: 'kubelet_volume_stats_capacity_bytes',
  inodes: 'kubelet_volume_stats_inodes',
  inodesUsed: 'kubelet_volume_stats_inodes_used'
} as const

export interface VolumeServiceOptions {
  kubernetes: Pick<ObservabilityKubernetes, 'allowed'> & { read: KubernetesReader }
  prometheusUrl: string | null
  request: HttpRequester
  // Per-caller admission shared with the metrics and logs tools.
  budget?: CallerBudget
  now?: () => number
}

export class VolumeService {
  constructor(private readonly options: VolumeServiceOptions) {}

  listVolumes(input: z.input<typeof volumesInput>, caller?: ObservabilityCaller) {
    const budget = this.options.budget

    if (!budget) return this.runListVolumes(this.options.request, input, caller)

    return budget.admit(caller?.identity.user || 'anonymous', charge =>
      this.runListVolumes(
        request => {
          charge()

          return this.options.request(request)
        },
        input,
        caller
      )
    )
  }

  private async runListVolumes(
    request: HttpRequester,
    input: z.input<typeof volumesInput>,
    caller?: ObservabilityCaller
  ) {
    const args = volumesInput.parse(input)

    if (!caller?.identity.user) throw new Error('Volume listing requires an authenticated caller')

    const { kubernetes } = this.options

    if (
      !(await kubernetes.allowed(caller.identity, {
        group: '',
        resource: 'persistentvolumeclaims',
        verb: 'list',
        ...(args.namespace ? { namespace: args.namespace } : {})
      }))
    )
      throw new Error(
        'Kubernetes RBAC denied list persistentvolumeclaims; specify a namespace for scoped access'
      )

    if (
      args.includeUnboundPVs &&
      !(await kubernetes.allowed(caller.identity, { group: '', resource: 'persistentvolumes', verb: 'list' }))
    )
      throw new Error('Kubernetes RBAC denied cluster-wide list persistentvolumes')

    const path = args.namespace
      ? `/api/v1/namespaces/${encodeURIComponent(args.namespace)}/persistentvolumeclaims`
      : '/api/v1/persistentvolumeclaims'
    const items = await collect(kubernetes.read, path, item => pvc.parse(item), {
      limit: 200,
      maxPages: 20,
      what: 'PVC listing'
    })

    if (
      items.some(
        item => !item.metadata.namespace || (args.namespace && item.metadata.namespace !== args.namespace)
      )
    )
      throw new Error('Kubernetes returned a claim outside the requested namespace')

    const degraded: { source: string; message: string }[] = []
    const persistentVolumes = new Map<string, ReturnType<typeof describePv>>()
    const bound = new Set(items.flatMap(item => (item.spec.volumeName ? [item.spec.volumeName] : [])))

    if (args.includeUnboundPVs) {
      const all = await collect(kubernetes.read, '/api/v1/persistentvolumes', item => pv.parse(item), {
        limit: 200,
        maxPages: 20,
        what: 'PV listing'
      })

      for (const item of all)
        if (bound.has(item.metadata.name) || item.status?.phase !== 'Bound')
          persistentVolumes.set(item.metadata.name, describePv(item))
    } else {
      const names = [...bound]

      for (let offset = 0; offset < names.length; offset += 4)
        await Promise.all(
          names.slice(offset, offset + 4).map(async name => {
            try {
              if (
                !(await kubernetes.allowed(caller.identity, {
                  group: '',
                  resource: 'persistentvolumes',
                  verb: 'get',
                  name
                }))
              ) {
                degraded.push({
                  source: name,
                  message: 'PV details unavailable: caller lacks get persistentvolumes permission'
                })

                return
              }

              const item = pv.parse(
                JSON.parse(await kubernetes.read(`/api/v1/persistentvolumes/${encodeURIComponent(name)}`))
              )

              if (item.metadata.name !== name) throw new Error('Kubernetes returned an unexpected PV')

              persistentVolumes.set(name, describePv(item))
            } catch (error) {
              degraded.push({
                source: name,
                message: error instanceof Error ? error.message : 'PV read failed'
              })
            }
          })
        )
    }

    const claims = items
      .map(item => ({
        namespace: item.metadata.namespace!,
        name: item.metadata.name,
        phase: item.status?.phase ?? null,
        storageClass: item.spec.storageClassName ?? null,
        requestedStorage: item.spec.resources?.requests?.storage ?? null,
        provisionedStorage: item.status?.capacity?.storage ?? null,
        volumeMode: item.spec.volumeMode ?? 'Filesystem',
        accessModes: item.spec.accessModes ?? [],
        boundVolume: item.spec.volumeName ?? null,
        usage: {
          usedBytes: null as number | null,
          capacityBytes: null as number | null,
          inodes: null as number | null,
          inodesUsed: null as number | null
        }
      }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name))
    const byClaim = new Map(claims.map(claim => [`${claim.namespace}/${claim.name}`, claim]))
    const observedAt = new Date((this.options.now ?? Date.now)()).toISOString()
    const metricSources: { field: string; metric: string; query: string; error?: string }[] = []

    if (this.options.prometheusUrl && claims.length) {
      await Promise.all(
        Object.entries(metrics).map(async ([field, metric]) => {
          const selector = args.namespace ? `{namespace=${JSON.stringify(args.namespace)}}` : ''
          const query = `max by (namespace,persistentvolumeclaim) (${metric}${selector})`
          const source: (typeof metricSources)[number] = { field, metric, query }

          metricSources.push(source)
          try {
            const url = new URL(`${this.options.prometheusUrl!.replace(/\/$/, '')}/api/v1/query`)

            url.searchParams.set('query', query)
            url.searchParams.set('time', observedAt)
            url.searchParams.set('limit', '10001')
            const response = await request({ url })

            if (response.status !== 200) throw new Error(`Prometheus returned HTTP ${response.status}`)

            const result = sample.parse(JSON.parse(response.body))

            if (result.data.result.length > 10000) throw new Error('Volume metrics exceeded the series limit')

            if (
              args.namespace &&
              result.data.result.some(series => series.metric.namespace !== args.namespace)
            )
              throw new Error('Prometheus returned volume metrics outside the requested namespace')

            for (const series of result.data.result) {
              const claim = byClaim.get(`${series.metric.namespace}/${series.metric.persistentvolumeclaim}`)
              const value = Number(series.value[1])

              if (claim && Number.isFinite(value) && value >= 0)
                claim.usage[field as keyof typeof metrics] = value
            }

            for (const warning of result.warnings ?? []) degraded.push({ source: metric, message: warning })
          } catch (error) {
            source.error = error instanceof Error ? error.message : 'Volume metric query failed'
            degraded.push({ source: metric, message: source.error })
          }
        })
      )
    } else if (!this.options.prometheusUrl)
      degraded.push({
        source: 'prometheus',
        message: 'Prometheus is not configured; volume inventory is available without usage statistics'
      })

    return {
      observedAt,
      namespace: args.namespace ?? null,
      claims,
      persistentVolumes: [...persistentVolumes.values()].sort((a, b) => a.name.localeCompare(b.name)),
      metricSources: metricSources.sort((a, b) => a.field.localeCompare(b.field)),
      degraded: degraded.sort((a, b) => a.source.localeCompare(b.source)),
      notes: [
        'PVC and PV inventory comes from the Kubernetes API. Bound PV details require get permission for that PV; includeUnboundPVs requires cluster-wide list PV permission.',
        'Requested and provisioned storage retain Kubernetes quantity units. Usage and capacity bytes, inode count and used inode count come from kubelet volume metrics, deduplicated by namespace and claim.',
        'Absent volume samples are null, not zero. Metrics may be unavailable for unmounted claims or unsupported volume modes/drivers. Shared claim usage covers the volume as a whole. No CSI volume attributes or secret references are exported.'
      ]
    }
  }
}
