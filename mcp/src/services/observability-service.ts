import {
  getPodResourceUsageHistory,
  getClusterResourceUsageHistory,
  podResourceUsageHistoryInput,
  clusterResourceUsageHistoryInput,
  getPodResourceUsage,
  getClusterResourceUsage,
  podResourceUsageInput,
  clusterResourceUsageInput
} from './resource-usage.js'
import { z } from 'zod'
import type { HttpRequester } from '../clients/observability-http.js'
import type { KubernetesIdentity, ObservabilityKubernetes } from '../clients/observability-kubernetes.js'

const namespace = z
  .string()
  .max(63)
  .regex(/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/)
const podName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/)
const labelName = z
  .string()
  .max(128)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
const timestamp = z.iso.datetime({ offset: true })

export const metricsInput = z
  .object({
    namespace,
    metric: z
      .string()
      .max(256)
      .regex(/^[a-zA-Z_:][a-zA-Z0-9_:]*$/),
    labels: z.record(labelName, z.string().max(1024)).optional(),
    operation: z.enum(['raw', 'rate', 'increase']).default('raw'),
    windowSeconds: z.number().int().min(60).max(86400).default(300),
    aggregate: z.enum(['sum', 'avg', 'min', 'max', 'count']).optional(),
    groupBy: z.array(labelName).max(10).optional(),
    start: timestamp.optional(),
    end: timestamp.optional(),
    stepSeconds: z.number().int().min(15).max(86400).default(60),
    limit: z.number().int().min(1).max(1000).default(100)
  })
  .strict()

export const logsInput = z
  .object({
    namespace,
    pod: podName,
    container: namespace.optional(),
    contains: z.string().max(1024).optional(),
    start: timestamp.optional(),
    end: timestamp.optional(),
    limit: z.number().int().min(1).max(1000).default(100)
  })
  .strict()

export interface ObservabilityCaller {
  identity: KubernetesIdentity
}

export interface ObservabilityServiceOptions {
  prometheusUrl: string | null
  lokiUrl: string | null
  kubernetes: ObservabilityKubernetes
  request: HttpRequester
  now?: () => number
}

const labelsSchema = z.record(z.string(), z.string())
const sampleSchema = z.tuple([z.number(), z.string()])
const prometheusResponse = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.enum(['vector', 'matrix']),
    result: z.array(
      z.object({
        metric: labelsSchema,
        value: sampleSchema.optional(),
        values: z.array(sampleSchema).optional(),
        // Preserve native histograms when a selected metric uses them.
        histogram: z.unknown().optional(),
        histograms: z.unknown().optional()
      })
    )
  }),
  warnings: z.array(z.string()).optional(),
  infos: z.array(z.string()).optional()
})
const lokiResponse = z.object({
  status: z.literal('success'),
  data: z.object({
    resultType: z.literal('streams'),
    result: z.array(
      z.object({
        stream: labelsSchema,
        values: z.array(z.tuple([z.string().regex(/^\d+$/), z.string()]).rest(z.unknown()))
      })
    )
  })
})

export class ObservabilityService {
  readonly metricsEnabled: boolean
  constructor(private readonly options: ObservabilityServiceOptions) {
    this.metricsEnabled = Boolean(options.prometheusUrl)
  }

  getPodResourceUsage(input: z.input<typeof podResourceUsageInput>, caller?: ObservabilityCaller) {
    return getPodResourceUsage(this.options, input, caller)
  }

  getClusterResourceUsage(input: z.input<typeof clusterResourceUsageInput>, caller?: ObservabilityCaller) {
    return getClusterResourceUsage(this.options, input, caller)
  }

  getPodResourceUsageHistory(
    input: z.input<typeof podResourceUsageHistoryInput>,
    caller?: ObservabilityCaller
  ) {
    return getPodResourceUsageHistory(this.options, input, caller)
  }

  getClusterResourceUsageHistory(
    input: z.input<typeof clusterResourceUsageHistoryInput>,
    caller?: ObservabilityCaller
  ) {
    return getClusterResourceUsageHistory(this.options, input, caller)
  }

  private async authorize(caller: ObservabilityCaller | undefined, ns: string, pod?: string): Promise<void> {
    if (!caller?.identity.user) {
      throw new Error('Observability requires an authenticated caller; anonymous access is disabled')
    }

    const allowed = await this.options.kubernetes.allowed(
      caller.identity,
      pod
        ? { namespace: ns, group: '', resource: 'pods', subresource: 'log', verb: 'get', name: pod }
        : { namespace: ns, group: '', resource: 'pods', verb: 'list' }
    )

    if (!allowed) {
      throw new Error(`Kubernetes RBAC denied ${pod ? 'get pods/log' : 'list pods'} in namespace ${ns}`)
    }
  }

  async queryMetrics(input: z.input<typeof metricsInput>, caller?: ObservabilityCaller) {
    const args = metricsInput.parse(input)

    if (!this.options.prometheusUrl) throw new Error('PROMETHEUS_URL is not configured')

    if (args.labels && (Object.hasOwn(args.labels, 'namespace') || Object.hasOwn(args.labels, '__name__'))) {
      throw new Error('namespace and __name__ cannot be supplied as label filters')
    }

    if (Object.keys(args.labels ?? {}).length > 20) throw new Error('At most 20 label filters are allowed')

    if (Boolean(args.start) !== Boolean(args.end)) throw new Error('Range queries require both start and end')

    if (args.groupBy && !args.aggregate) throw new Error('groupBy requires aggregate')

    if (args.start && args.end) {
      validateRange(Date.parse(args.start), Date.parse(args.end))

      if ((Date.parse(args.end) - Date.parse(args.start)) / (args.stepSeconds * 1000) > 11000) {
        throw new Error('Too many range samples; increase stepSeconds')
      }
    }

    await this.authorize(caller, args.namespace)
    const matchers = Object.entries({ namespace: args.namespace, ...args.labels })
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(',')
    let query = `${args.metric}{${matchers}}`

    if (args.operation !== 'raw') query = `${args.operation}(${query}[${args.windowSeconds}s])`

    if (args.aggregate) {
      // Retain namespace in every result, including aggregates.
      const groups = [...new Set(['namespace', ...(args.groupBy ?? [])])]

      query = `${args.aggregate} by (${groups.join(',')}) (${query})`
    }

    const url = endpoint(this.options.prometheusUrl, args.start ? '/api/v1/query_range' : '/api/v1/query')

    url.searchParams.set('query', query)
    url.searchParams.set('limit', String(args.limit))

    if (args.start && args.end) {
      url.searchParams.set('start', args.start)
      url.searchParams.set('end', args.end)
      url.searchParams.set('step', String(args.stepSeconds))
    }

    const response = await this.options.request({ url })

    if (response.status !== 200) throw new Error(`Prometheus returned HTTP ${response.status}`)

    const result = prometheusResponse.parse(JSON.parse(response.body))

    if (result.data.result.some(series => series.metric.namespace !== args.namespace)) {
      throw new Error('Prometheus returned a result outside the requested namespace')
    }

    return {
      source: 'prometheus',
      namespace: args.namespace,
      query,
      ...result.data,
      result: result.data.result.slice(0, args.limit),
      warnings: result.warnings ?? [],
      infos: result.infos ?? []
    }
  }

  async queryLogs(input: z.input<typeof logsInput>, caller?: ObservabilityCaller) {
    const args = logsInput.parse(input)
    const end = args.end ? Date.parse(args.end) : (this.options.now ?? Date.now)()
    const start = args.start ? Date.parse(args.start) : end - 3600000

    validateRange(start, end)
    await this.authorize(caller, args.namespace, args.pod)

    if (this.options.lokiUrl) {
      return this.lokiLogs(args, start, end)
    }

    // LOKI_URL selects the source. A configured Loki failure is not permission
    // to switch sources; only an unset URL selects Kubernetes logs.
    const parameters = new URLSearchParams({
      timestamps: 'true',
      sinceTime: new Date(start).toISOString(),
      tailLines: String(args.limit),
      limitBytes: '1048576',
      follow: 'false'
    })

    if (args.container) parameters.set('container', args.container)

    const body = await this.options.kubernetes.podLogs(args.namespace, args.pod, parameters)
    const entries = body
      .split('\n')
      .flatMap(line => {
        const separator = line.indexOf(' ')

        if (separator < 0) return []

        const timestamp = line.slice(0, separator)
        const time = Date.parse(timestamp)
        const text = line.slice(separator + 1)

        if (
          !Number.isFinite(time) ||
          time < start ||
          time > end ||
          (args.contains && !text.includes(args.contains))
        )
          return []

        return [{ timestamp, line: text }]
      })
      .slice(-args.limit)
      .reverse()

    return {
      source: 'kubernetes',
      namespace: args.namespace,
      pod: args.pod,
      container: args.container ?? null,
      entries,
      warnings: [
        'Kubernetes returns only retained logs from the current container instance. Results are limited to the latest requested lines and 1 MiB before time/text filtering; archived or deleted pod logs are unavailable. Specify container for multi-container pods.'
      ]
    }
  }

  private async lokiLogs(args: z.output<typeof logsInput>, start: number, end: number) {
    const matchers = {
      namespace: args.namespace,
      pod: args.pod,
      ...(args.container ? { container: args.container } : {})
    }
    let query = `{${Object.entries(matchers)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(',')}}`

    if (args.contains) query += ` |= ${JSON.stringify(args.contains)}`

    const url = endpoint(this.options.lokiUrl!, '/loki/api/v1/query_range')

    url.searchParams.set('query', query)
    url.searchParams.set('start', String(BigInt(start) * 1000000n))
    url.searchParams.set('end', String(BigInt(end) * 1000000n))
    url.searchParams.set('limit', String(args.limit))
    url.searchParams.set('direction', 'backward')
    const response = await this.options.request({ url })

    if (response.status !== 200) throw new Error(`Loki returned HTTP ${response.status}`)

    const result = lokiResponse.parse(JSON.parse(response.body))

    if (
      result.data.result.some(stream =>
        Object.entries(matchers).some(([key, value]) => stream.stream[key] !== value)
      )
    ) {
      throw new Error('Loki returned a stream outside the requested scope')
    }

    return {
      source: 'loki',
      namespace: args.namespace,
      pod: args.pod,
      query,
      streams: result.data.result,
      warnings: []
    }
  }
}

function endpoint(base: string, path: string): URL {
  return new URL(`${base.replace(/\/+$/, '')}${path}`)
}

function validateRange(start: number, end: number): void {
  if (end <= start || end - start > 7 * 86400000)
    throw new Error('Time range must be positive and at most seven days')
}
