import { z } from 'zod'
import type { ObservabilityCaller, ObservabilityServiceOptions } from './observability-service.js'

const historySeconds = z.number().int().min(300).max(86400).default(3600)
const stepSeconds = z.number().int().min(60).max(900).default(60)
const windowSeconds = z.number().int().min(60).max(3600).default(300)

export const podResourceUsageInput = z
  .object({
    namespace: z
      .string()
      .max(63)
      .regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/),
    pod: z
      .string()
      .max(253)
      .regex(/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/),
    windowSeconds,
    perContainer: z.boolean().default(true)
  })
  .strict()
export const clusterResourceUsageInput = z
  .object({
    windowSeconds,
    perNode: z.boolean().default(false)
  })
  .strict()

export const resourceUsageHistoryInput = z.object({ historySeconds, stepSeconds }).strict()
export const podResourceUsageHistoryInput = podResourceUsageInput.extend(resourceUsageHistoryInput.shape)
export const clusterResourceUsageHistoryInput = clusterResourceUsageInput.extend(
  resourceUsageHistoryInput.shape
)

export interface Statistics {
  avg: number
  min: number
  max: number
  stddev: number
  sampleCount: number
  expectedSamples: number
  coverage: number
  firstSampleAt?: string
  lastSampleAt?: string
}

export function summarizeSamples(
  values: number[],
  expectedSamples: number,
  timestamps?: number[]
): Statistics | null {
  if (!values.length) return null

  let avg = 0,
    m2 = 0,
    count = 0,
    min = Infinity,
    max = -Infinity

  for (const value of values) {
    count += 1
    const delta = value - avg

    avg += delta / count
    m2 += delta * (value - avg)
    min = Math.min(min, value)
    max = Math.max(max, value)
  }

  return {
    avg,
    min,
    max,
    stddev: Math.sqrt(Math.max(0, m2 / count)),
    sampleCount: count,
    expectedSamples,
    coverage: count / expectedSamples,
    ...(timestamps?.length
      ? {
          firstSampleAt: new Date(Math.min(...timestamps) * 1000).toISOString(),
          lastSampleAt: new Date(Math.max(...timestamps) * 1000).toISOString()
        }
      : {})
  }
}

// Only summaries leave the tool; sampled histories are released with the result objects.
const histories = new WeakMap<Quantity, Map<number, number>>()

export interface Sample {
  labels: Record<string, string>
  value: number
  statistics?: Statistics | null
}
export interface Quantity {
  unit: string
  sourceMetrics?: string[]
  calculation?: string
  total: number | null
  statistics?: Statistics | null
  statisticsError?: string
  historyBreakdown?: { labels: Record<string, string>; statistics: Statistics | null }[]
  breakdown?: Sample[]
  query?: string
  warnings: string[]
  error?: string
}
type Queries = Record<string, { unit: string; query: string }>
const vector = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('vector'),
    result: z.array(
      z.object({
        metric: z.record(z.string(), z.string()),
        value: z.tuple([z.number(), z.string()])
      })
    )
  }),
  warnings: z.array(z.string()).optional(),
  infos: z.array(z.string()).optional()
})

const matrix = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('matrix'),
    result: z.array(
      z.object({
        metric: z.record(z.string(), z.string()),
        values: z.array(z.tuple([z.number(), z.string()]))
      })
    )
  }),
  warnings: z.array(z.string()).optional(),
  infos: z.array(z.string()).optional()
})
const labelKey = (labels: Record<string, string>) =>
  JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))

async function snapshot(
  options: ObservabilityServiceOptions,
  queries: Queries,
  breakdown: boolean,
  history?: { historySeconds: number; stepSeconds: number },
  scope?: { namespace: string; pod: string }
) {
  if (!options.prometheusUrl) throw new Error('PROMETHEUS_URL is not configured')

  const align = options.queryTimeAlignmentMs ?? 0
  const current = (options.now ?? Date.now)()
  // Aligned so a refresh within the window asks Prometheus the identical query.
  const observedAt = new Date(align > 0 ? current - (current % align) : current).toISOString()
  const end = Date.parse(observedAt) / 1000
  const start = end - (history?.historySeconds ?? 0)
  const expectedSamples = history ? Math.floor(history.historySeconds / history.stepSeconds) + 1 : 0
  const metrics: Record<string, Quantity> = {}
  const entries = Object.entries(queries)

  // Fixed query count and four concurrent requests; the HTTP client also bounds bodies and timeouts.
  for (let offset = 0; offset < entries.length; offset += 4) {
    await Promise.all(
      entries.slice(offset, offset + 4).map(async ([name, definition]) => {
        const quantity: Quantity = {
          unit: definition.unit,
          sourceMetrics: [
            ...new Set(
              definition.query.match(
                /\b(?:container|node|kube|kubelet|topolvm)_[a-zA-Z0-9_:]+(?=\s*[{}()[\s])/g
              ) ?? []
            )
          ],
          calculation: 'Sum of deduplicated returned series; exact aggregation is in query',
          total: null,
          query: definition.query,
          warnings: []
        }

        metrics[name] = quantity
        try {
          const url = new URL(`${options.prometheusUrl!.replace(/\/$/, '')}/api/v1/query`)

          url.searchParams.set('query', definition.query)
          url.searchParams.set('time', observedAt)
          url.searchParams.set('limit', '10001')
          const response = await options.request({ url })

          if (response.status !== 200) throw new Error(`Prometheus returned HTTP ${response.status}`)

          const result = vector.parse(JSON.parse(response.body))

          if (result.data.result.length > 10000)
            throw new Error('Metric exceeded the series limit; incomplete results discarded')

          if (
            scope &&
            result.data.result.some(
              item => item.metric.namespace !== scope.namespace || item.metric.pod !== scope.pod
            )
          ) {
            throw new Error('Prometheus returned a result outside the requested pod')
          }

          quantity.warnings = [...(result.warnings ?? []), ...(result.infos ?? [])]
          const samples = result.data.result.map(item => ({
            labels: item.metric,
            value: Number(item.value[1])
          }))

          if (samples.some(sample => !Number.isFinite(sample.value)))
            throw new Error('Metric contains a non-finite sample')

          quantity.total = samples.length ? samples.reduce((sum, sample) => sum + sample.value, 0) : null

          if (breakdown) quantity.breakdown = samples

          if (!samples.length) quantity.warnings.push('No samples available')

          if (history)
            try {
              url.pathname = url.pathname.replace(/query$/, 'query_range')
              url.searchParams.delete('time')
              url.searchParams.set('start', String(start))
              url.searchParams.set('end', String(end))
              url.searchParams.set('step', String(history.stepSeconds))
              const response = await options.request({ url })

              if (response.status !== 200)
                throw new Error(`Prometheus range query returned HTTP ${response.status}`)

              const range = matrix.parse(JSON.parse(response.body))

              if (
                range.data.result.length > 10000 ||
                range.data.result.reduce((sum, series) => sum + series.values.length, 0) > 100000
              )
                throw new Error('History exceeded the sample limit')

              if (
                scope &&
                range.data.result.some(
                  series => series.metric.namespace !== scope.namespace || series.metric.pod !== scope.pod
                )
              )
                throw new Error('Prometheus history returned a result outside the requested pod')

              quantity.warnings.push(...(range.warnings ?? []), ...(range.infos ?? []))
              const totals = new Map<number, number>()
              const counts = new Map<number, number>()
              const perSeries = new Map<string, Statistics | null>()

              if (breakdown) quantity.historyBreakdown = []

              for (const series of range.data.result) {
                const values: number[] = []
                const timestamps: number[] = []

                for (const [timestamp, raw] of series.values) {
                  const value = Number(raw)

                  if (!Number.isFinite(value)) {
                    quantity.warnings.push('Non-finite history sample omitted')
                    continue
                  }

                  values.push(value)
                  timestamps.push(timestamp)
                  totals.set(timestamp, (totals.get(timestamp) ?? 0) + value)
                  counts.set(timestamp, (counts.get(timestamp) ?? 0) + 1)
                }

                const statistics = summarizeSamples(values, expectedSamples, timestamps)

                perSeries.set(labelKey(series.metric), statistics)
                quantity.historyBreakdown?.push({ labels: series.metric, statistics })
              }

              histories.set(quantity, totals)
              quantity.statistics = summarizeSamples([...totals.values()], expectedSamples, [
                ...totals.keys()
              ])

              if (quantity.statistics && quantity.statistics.coverage < 1)
                quantity.warnings.push(
                  'History has missing time samples; statistics use available samples only'
                )

              if (new Set(counts.values()).size > 1)
                quantity.warnings.push(
                  'History series coverage changes over time; totals may cover different resources'
                )

              if (quantity.breakdown)
                for (const sample of quantity.breakdown)
                  sample.statistics = perSeries.get(labelKey(sample.labels)) ?? null
            } catch (error) {
              quantity.statisticsError = error instanceof Error ? error.message : 'History query failed'
            }
        } catch (error) {
          quantity.error = error instanceof Error ? error.message : 'Metric query failed'
        }
      })
    )
  }

  const actual = Object.values(metrics)
    .flatMap(quantity =>
      quantity.statistics?.firstSampleAt && quantity.statistics.lastSampleAt
        ? [quantity.statistics.firstSampleAt, quantity.statistics.lastSampleAt]
        : []
    )
    .sort()

  return {
    source: 'prometheus' as const,
    observedAt,
    metrics,
    ...(history
      ? {
          history: {
            seconds: history.historySeconds,
            stepSeconds: history.stepSeconds,
            stddev: 'population',
            requestedStart: new Date(start * 1000).toISOString(),
            requestedEnd: observedAt,
            firstSampleAt: actual[0] ?? null,
            lastSampleAt: actual.at(-1) ?? null
          }
        }
      : {})
  }
}

function ratio(metrics: Record<string, Quantity>, name: string, numerator: string, denominator: string) {
  const a = metrics[numerator],
    b = metrics[denominator]
  const quantity: Quantity = {
    unit: 'ratio',
    sourceMetrics: [...new Set([...(a.sourceMetrics ?? []), ...(b.sourceMetrics ?? [])])],
    calculation: `${numerator} / ${denominator}`,
    total: a.total !== null && b.total !== null && b.total > 0 ? a.total / b.total : null,
    warnings:
      a.total === null || b.total === null
        ? ['Required metric unavailable']
        : b.total <= 0
          ? ['Ratio undefined: denominator is zero']
          : []
  }

  if (a.breakdown && b.breakdown) {
    const key = (labels: Record<string, string>) =>
      JSON.stringify(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)))
    const denominators = new Map(b.breakdown.map(sample => [key(sample.labels), sample.value]))

    quantity.breakdown = a.breakdown.flatMap(sample => {
      const value = denominators.get(key(sample.labels))

      return value !== undefined && value > 0 ? [{ labels: sample.labels, value: sample.value / value }] : []
    })
  }

  const ah = histories.get(a),
    bh = histories.get(b)

  if (ah && bh) {
    const timestamps: number[] = []
    const values = [...ah].flatMap(([time, value]) => {
      const denominator = bh.get(time)

      if (denominator === undefined || denominator <= 0) return []

      timestamps.push(time)

      return [value / denominator]
    })

    quantity.statistics = summarizeSamples(values, a.statistics?.expectedSamples ?? 1, timestamps)
  }

  metrics[name] = quantity
}

async function authorize(
  options: ObservabilityServiceOptions,
  caller: ObservabilityCaller | undefined,
  namespace?: string
) {
  if (!caller?.identity.user) throw new Error('Observability requires an authenticated caller')

  const resources = namespace ? ['pods'] : ['pods', 'nodes']

  for (const resource of resources) {
    if (
      !(await options.kubernetes.allowed(caller.identity, {
        verb: 'list',
        group: '',
        resource,
        ...(namespace ? { namespace } : {})
      }))
    ) {
      throw new Error(
        `Kubernetes RBAC denied list ${resource} ${namespace ? `in namespace ${namespace}` : 'cluster-wide'}`
      )
    }
  }
}

export async function getPodResourceUsage(
  options: ObservabilityServiceOptions,
  input: z.input<typeof podResourceUsageInput>,
  caller?: ObservabilityCaller,
  historyInput?: z.input<typeof resourceUsageHistoryInput>
) {
  const args = podResourceUsageInput.parse(input)
  const history = historyInput ? resourceUsageHistoryInput.parse(historyInput) : undefined

  await authorize(options, caller, args.namespace)
  const selector = `namespace=${JSON.stringify(args.namespace)},pod=${JSON.stringify(args.pod)}`
  const containers = `${selector},container!="",container!="POD"`
  const groups = 'namespace,pod,container'
  const gauge = (metric: string, extra = '') => `max by (${groups}) (${metric}{${containers}${extra}})`
  const rate = (metric: string) =>
    `max by (${groups}) (rate(${metric}{${containers}}[${args.windowSeconds}s]))`
  const resource = (metric: string, name: string) =>
    `max by (${groups}) (${metric}{${selector},resource="${name}"})`
  const queries: Queries = {
    cpuUsed: { unit: 'cores', query: rate('container_cpu_usage_seconds_total') },
    cpuRequests: { unit: 'cores', query: resource('kube_pod_container_resource_requests', 'cpu') },
    cpuLimits: { unit: 'cores', query: resource('kube_pod_container_resource_limits', 'cpu') },
    cpuThrottledPeriods: { unit: 'periods/second', query: rate('container_cpu_cfs_throttled_periods_total') },
    cpuPeriods: { unit: 'periods/second', query: rate('container_cpu_cfs_periods_total') },
    memoryWorkingSet: { unit: 'bytes', query: gauge('container_memory_working_set_bytes') },
    memoryUsage: { unit: 'bytes', query: gauge('container_memory_usage_bytes') },
    memoryRequests: { unit: 'bytes', query: resource('kube_pod_container_resource_requests', 'memory') },
    memoryLimits: { unit: 'bytes', query: resource('kube_pod_container_resource_limits', 'memory') },
    networkRx: {
      unit: 'bytes/second',
      query: `max by (namespace,pod,interface) (rate(container_network_receive_bytes_total{${selector},interface!="lo"}[${args.windowSeconds}s]))`
    },
    networkTx: {
      unit: 'bytes/second',
      query: `max by (namespace,pod,interface) (rate(container_network_transmit_bytes_total{${selector},interface!="lo"}[${args.windowSeconds}s]))`
    },
    volumeUsage: {
      unit: 'bytes',
      query: `max by (namespace,pod,persistentvolumeclaim) (max by (namespace,persistentvolumeclaim) (kubelet_volume_stats_used_bytes) * on (namespace,persistentvolumeclaim) group_right() (max by (namespace,pod,persistentvolumeclaim) (kube_pod_spec_volumes_persistentvolumeclaims_info{${selector}})))`
    },
    volumeCapacity: {
      unit: 'bytes',
      query: `max by (namespace,pod,persistentvolumeclaim) (max by (namespace,persistentvolumeclaim) (kubelet_volume_stats_capacity_bytes) * on (namespace,persistentvolumeclaim) group_right() (max by (namespace,pod,persistentvolumeclaim) (kube_pod_spec_volumes_persistentvolumeclaims_info{${selector}})))`
    },
    filesystemUsage: {
      unit: 'bytes',
      query: `max by (namespace,pod,container,device) (container_fs_usage_bytes{${containers}})`
    }
  }
  const result = await snapshot(options, queries, args.perContainer, history, args)

  ratio(result.metrics, 'cpuThrottling', 'cpuThrottledPeriods', 'cpuPeriods')

  return {
    ...result,
    namespace: args.namespace,
    pod: args.pod,
    windowSeconds: args.windowSeconds,
    notes: [
      'Requests and limits are sums of reported regular container resources; they exclude init containers, pod overhead and pod-level resources.',
      'Network counters cover the shared pod network namespace and are deduplicated by interface, not attributed to individual containers.',
      'Filesystem usage is reported container filesystem usage. volumeUsage and volumeCapacity cover PVCs attached to this pod, deduplicated by claim; shared PVC usage cannot be attributed to this pod alone. Missing samples mean unavailable, not zero.'
    ]
  }
}

export async function getClusterResourceUsage(
  options: ObservabilityServiceOptions,
  input: z.input<typeof clusterResourceUsageInput>,
  caller?: ObservabilityCaller,
  historyInput?: z.input<typeof resourceUsageHistoryInput>
) {
  const args = clusterResourceUsageInput.parse(input)
  const history = historyInput ? resourceUsageHistoryInput.parse(historyInput) : undefined

  await authorize(options, caller)
  // Join exporters to the Kubernetes node inventory; monitoring may also scrape routers or other hosts.
  const inventory = 'max by (node) (kube_node_info)'
  const identities = `max by (instance,node) (node_uname_info{node!=""} or label_replace(node_uname_info{node=""}, "node", "$1", "nodename", "(.+)")) and on (node) ${inventory}`
  const host = (query: string, labels: boolean | string = false) =>
    `max by (node${labels ? ',' + (typeof labels === 'string' ? labels : 'device') : ''}) ((${query}) * on (instance) group_left (node) (${identities}))`
  const node = (metric: string) => host(`max by (instance) (${metric})`)
  const resources = (metric: string, resource: string) =>
    `sum by (node) (max by (namespace,pod,container,node) (${metric}{resource="${resource}"}))`
  const root = 'mountpoint="/"'
  const volumeGroupSize = `max by (node,device_class) (topolvm_volumegroup_size_bytes) and on (node) ${inventory}`
  const volumeGroupAvailable = `max by (node,device_class) (topolvm_volumegroup_available_bytes) and on (node) ${inventory}`
  const network = 'device!~"lo|veth.*|lxc.*|cali.*|cilium.*|flannel.*|docker.*|br-.*|virbr.*|tun.*|tap.*"'
  const queries: Queries = {
    cpuUsed: {
      unit: 'cores',
      query: host(
        `sum by (instance) (1 - max by (instance,cpu) (rate(node_cpu_seconds_total{mode="idle"}[${args.windowSeconds}s])))`
      )
    },
    cpuCapacity: {
      unit: 'cores',
      query: 'max by (node) (kube_node_status_capacity{resource="cpu",unit="core"})'
    },
    memoryCapacity: {
      unit: 'bytes',
      query: 'max by (node) (kube_node_status_capacity{resource="memory",unit="byte"})'
    },
    memoryAvailable: { unit: 'bytes', query: node('node_memory_MemAvailable_bytes') },
    memoryUsed: {
      unit: 'bytes',
      query: `${node('node_memory_MemTotal_bytes')} - ${node('node_memory_MemAvailable_bytes')}`
    },
    memoryCached: { unit: 'bytes', query: node('node_memory_Cached_bytes') },
    memoryBuffers: { unit: 'bytes', query: node('node_memory_Buffers_bytes') },
    cpuRequests: { unit: 'cores', query: resources('kube_pod_container_resource_requests', 'cpu') },
    cpuLimits: { unit: 'cores', query: resources('kube_pod_container_resource_limits', 'cpu') },
    memoryRequests: { unit: 'bytes', query: resources('kube_pod_container_resource_requests', 'memory') },
    memoryLimits: { unit: 'bytes', query: resources('kube_pod_container_resource_limits', 'memory') },
    rootFilesystemUsed: {
      unit: 'bytes',
      query: host(
        `max by (instance,device,mountpoint) (node_filesystem_size_bytes{${root}}) - max by (instance,device,mountpoint) (node_filesystem_free_bytes{${root}})`,
        'device,mountpoint'
      )
    },
    rootFilesystemCapacity: {
      unit: 'bytes',
      query: host(
        `max by (instance,device,mountpoint) (node_filesystem_size_bytes{${root}})`,
        'device,mountpoint'
      )
    },
    rootFilesystemAvailable: {
      unit: 'bytes',
      query: host(
        `max by (instance,device,mountpoint) (node_filesystem_avail_bytes{${root}})`,
        'device,mountpoint'
      )
    },
    lvmVolumeGroupSize: { unit: 'bytes', query: volumeGroupSize },
    lvmVolumeGroupAvailable: { unit: 'bytes', query: volumeGroupAvailable },
    lvmVolumeGroupAllocated: { unit: 'bytes', query: `(${volumeGroupSize}) - (${volumeGroupAvailable})` },
    networkRx: {
      unit: 'bytes/second',
      query: host(
        `max by (instance,device) (rate(node_network_receive_bytes_total{${network}}[${args.windowSeconds}s]))`,
        true
      )
    },
    networkTx: {
      unit: 'bytes/second',
      query: host(
        `max by (instance,device) (rate(node_network_transmit_bytes_total{${network}}[${args.windowSeconds}s]))`,
        true
      )
    }
  }
  const result = await snapshot(options, queries, true, history)

  ratio(result.metrics, 'cpuUtilization', 'cpuUsed', 'cpuCapacity')
  ratio(result.metrics, 'memoryUtilization', 'memoryUsed', 'memoryCapacity')
  ratio(result.metrics, 'rootFilesystemUtilization', 'rootFilesystemUsed', 'rootFilesystemCapacity')
  ratio(result.metrics, 'lvmVolumeGroupAllocation', 'lvmVolumeGroupAllocated', 'lvmVolumeGroupSize')
  const expected = new Set(result.metrics.cpuCapacity.breakdown?.map(sample => sample.labels.node))

  for (const [name, quantity] of Object.entries(result.metrics)) {
    if (
      !name.endsWith('Requests') &&
      !name.endsWith('Limits') &&
      !name.startsWith('lvm') &&
      expected.size &&
      quantity.breakdown
    ) {
      const observed = new Set(quantity.breakdown.map(sample => sample.labels.node))
      const missing = [...expected].filter(node => !observed.has(node))

      if (missing.length) quantity.warnings.push(`Partial node coverage; missing: ${missing.join(', ')}`)
    }

    if (!args.perNode) {
      delete quantity.breakdown
      delete quantity.historyBreakdown
    }
  }

  return {
    ...result,
    windowSeconds: args.windowSeconds,
    notes: [
      'Host usage comes from node-exporter. CPU used includes all non-idle time; memory used is total minus available, not total minus free.',
      'Host totals include Kubernetes nodes only, excluding other monitored hosts such as routers. node_uname_info maps exporter addresses to node names; kube_node_info filters those names to the Kubernetes inventory. sourceMetrics and query identify the metrics behind each figure.',
      'Requests and limits sum regular container declarations, not scheduler effective pod requirements.',
      'Root filesystem metrics select mountpoint="/" only. TopoLVM volume-group allocation is size minus available space; it describes allocated LVM capacity, not filesystem data written inside PVCs. Breakdown retains node, device, mountpoint and device_class labels. Network totals exclude common virtual interfaces; bonded or bridged interfaces may still overlap.',
      'Missing samples mean unavailable, not zero. This Prometheus endpoint must contain metrics for this cluster only.'
    ]
  }
}

export async function getPodResourceUsageHistory(
  options: ObservabilityServiceOptions,
  input: z.input<typeof podResourceUsageHistoryInput>,
  caller?: ObservabilityCaller
) {
  const { historySeconds, stepSeconds, ...snapshot } = podResourceUsageHistoryInput.parse(input)

  return getPodResourceUsage(options, snapshot, caller, { historySeconds, stepSeconds })
}

export async function getClusterResourceUsageHistory(
  options: ObservabilityServiceOptions,
  input: z.input<typeof clusterResourceUsageHistoryInput>,
  caller?: ObservabilityCaller
) {
  const { historySeconds, stepSeconds, ...snapshot } = clusterResourceUsageHistoryInput.parse(input)

  return getClusterResourceUsage(options, snapshot, caller, { historySeconds, stepSeconds })
}
