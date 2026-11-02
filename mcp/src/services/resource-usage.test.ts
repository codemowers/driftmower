import { describe, expect, it, vi } from 'vitest'
import {
  getClusterResourceUsage,
  getPodResourceUsage,
  getPodResourceUsageHistory,
  getClusterResourceUsageHistory,
  summarizeSamples
} from './resource-usage.js'
import type { ObservabilityKubernetes } from '../clients/observability-kubernetes.js'
import { ObservabilityService, type ObservabilityServiceOptions } from './observability-service.js'
import { createCallerBudget } from '../clients/backend-guard.js'

const caller = { identity: { user: 'alice', groups: ['team-a'] } }
const pod = { namespace: 'team-a', pod: 'api' }
const labels = { ...pod, container: 'web' }

function setup() {
  const allowed = vi.fn<ObservabilityKubernetes['allowed']>(async () => true)
  const request = vi.fn(async ({ url }: { url: URL }) => ({
    status: 200,
    body: JSON.stringify({
      status: 'success',
      data: url.pathname.endsWith('query_range')
        ? {
            resultType: 'matrix',
            result: [
              {
                metric: labels,
                values: [
                  [1, '2'],
                  [2, '4'],
                  [3, '6']
                ]
              }
            ]
          }
        : { resultType: 'vector', result: [{ metric: labels, value: [3, '6'] }] }
    })
  }))
  const options: ObservabilityServiceOptions = {
    prometheusUrl: 'http://prometheus',
    lokiUrl: null,
    kubernetes: { allowed, podLogs: vi.fn() },
    request,
    now: () => Date.parse('2026-10-04T10:00:00Z')
  }

  return { options, allowed, request }
}

describe('resource usage snapshots', () => {
  it('summarizes temporal samples with population stddev without treating absent samples as zero', () => {
    expect(summarizeSamples([2, 4, 6], 4)).toEqual({
      avg: 4,
      min: 2,
      max: 6,
      stddev: Math.sqrt(8 / 3),
      sampleCount: 3,
      expectedSamples: 4,
      coverage: 0.75
    })
    expect(summarizeSamples([], 61)).toBeNull()
    expect(summarizeSamples([0, 0], 2)?.stddev).toBe(0)
  })

  it('snapshots do not issue range queries or include statistics', async () => {
    const { options, request } = setup()
    const result = await getPodResourceUsage(options, pod, caller)

    expect(result.metrics.cpuThrottledTime).toBeUndefined()
    expect(
      request.mock.calls.some(([{ url }]) => url.search.includes('container_cpu_cfs_throttled_seconds_total'))
    ).toBe(false)
    expect(result.history).toBeUndefined()
    expect(result.metrics.cpuUsed.statistics).toBeUndefined()
    expect(request.mock.calls.every(([{ url }]) => url.pathname === '/api/v1/query')).toBe(true)
  })

  it('keeps historical containers and their sample timestamps after the pod disappears', async () => {
    const { options, request } = setup()

    request.mockImplementation(async ({ url }) => ({
      status: 200,
      body: JSON.stringify({
        status: 'success',
        data: url.pathname.endsWith('query_range')
          ? {
              resultType: 'matrix',
              result: [
                {
                  metric: labels,
                  values: [
                    [1791104520, '2'],
                    [1791104580, '4']
                  ]
                }
              ]
            }
          : { resultType: 'vector', result: [] }
      })
    }))
    const result = await getPodResourceUsageHistory(options, pod, caller)

    expect(result.metrics.cpuUsed.total).toBeNull()
    expect(result.metrics.cpuUsed.statistics).toMatchObject({
      avg: 3,
      sampleCount: 2,
      firstSampleAt: new Date(1791104520000).toISOString(),
      lastSampleAt: new Date(1791104580000).toISOString()
    })
    expect(result.metrics.cpuUsed.historyBreakdown?.[0].labels.container).toBe('web')
    expect(result.history?.firstSampleAt).not.toBeNull()
  })

  it('scopes pod queries, defaults to one hour and gives current totals plus temporal summaries', async () => {
    const { options, request, allowed } = setup()
    const result = await getPodResourceUsageHistory(options, pod, caller)

    expect(allowed).toHaveBeenCalledExactlyOnceWith(caller.identity, {
      namespace: 'team-a',
      resource: 'pods',
      group: '',
      verb: 'list'
    })
    expect(result.history).toMatchObject({
      seconds: 3600,
      stepSeconds: 60,
      stddev: 'population',
      requestedStart: '2026-10-04T09:00:00.000Z',
      requestedEnd: '2026-10-04T10:00:00.000Z',
      firstSampleAt: '1970-01-01T00:00:01.000Z',
      lastSampleAt: '1970-01-01T00:00:03.000Z'
    })
    expect(result.metrics.cpuUsed).toMatchObject({
      total: 6,
      unit: 'cores',
      statistics: { avg: 4, min: 2, max: 6, sampleCount: 3, expectedSamples: 61 }
    })
    expect(result.metrics.cpuUsed.breakdown?.[0].statistics?.avg).toBe(4)
    expect(result.metrics.cpuThrottling).toMatchObject({ total: 1, statistics: { avg: 1, stddev: 0 } })
    for (const [{ url }] of request.mock.calls) {
      expect(url.searchParams.get('query')).toContain('namespace="team-a",pod="api"')

      if (url.pathname.endsWith('query_range')) {
        expect(Number(url.searchParams.get('end')) - Number(url.searchParams.get('start'))).toBe(3600)
        expect(url.searchParams.get('step')).toBe('60')
      } else expect(url.searchParams.get('time')).toBe('2026-10-04T10:00:00.000Z')
    }
  })

  it.each([undefined, caller])(
    'fails closed before querying when identity or RBAC denies access: %j',
    async identity => {
      const { options, allowed, request } = setup()

      allowed.mockResolvedValue(false)
      await expect(getPodResourceUsage(options, pod, identity)).rejects.toThrow()
      await expect(getClusterResourceUsage(options, {}, identity)).rejects.toThrow()
      expect(request).not.toHaveBeenCalled()
    }
  )

  it('requires both cluster-wide pod and node access and restricts host queries to the node inventory', async () => {
    const { options, allowed, request } = setup()
    const result = await getClusterResourceUsageHistory(
      options,
      { historySeconds: 7200, stepSeconds: 120 },
      caller
    )

    expect(allowed.mock.calls.map(call => call[1])).toEqual([
      { resource: 'pods', group: '', verb: 'list' },
      { resource: 'nodes', group: '', verb: 'list' }
    ])
    expect(result.metrics.cpuUsed.query).toContain('kube_node_info')
    expect(result.metrics.cpuUsed.sourceMetrics).toEqual(
      expect.arrayContaining(['node_cpu_seconds_total', 'node_uname_info', 'kube_node_info'])
    )
    expect(result.metrics.rootFilesystemCapacity.query).toContain('mountpoint="/"')
    expect(result.metrics.rootFilesystemCapacity.sourceMetrics).toContain('node_filesystem_size_bytes')
    expect(result.metrics.lvmVolumeGroupSize.sourceMetrics).toContain('topolvm_volumegroup_size_bytes')
    expect(result.metrics.lvmVolumeGroupAvailable.sourceMetrics).toContain(
      'topolvm_volumegroup_available_bytes'
    )
    expect(result.metrics.filesystemUsage).toBeUndefined()
    expect(result.metrics.cpuUsed.query).toContain('group_left (node)')
    expect(result.metrics.cpuUsed.breakdown).toBeUndefined()
    expect(
      request.mock.calls
        .find(([{ url }]) => url.pathname.endsWith('query_range'))?.[0]
        .url.searchParams.get('step')
    ).toBe('120')
  })

  it('does not query when node access is denied after pod access is granted', async () => {
    const { options, allowed, request } = setup()

    allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await expect(getClusterResourceUsage(options, {}, caller)).rejects.toThrow('list nodes')
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps missing series, invalid values and query failures explicit', async () => {
    const { options, request } = setup()

    request.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } })
    })
    let result = await getPodResourceUsage(options, pod, caller)

    expect(result.metrics.cpuUsed.total).toBeNull()
    expect(result.metrics.cpuUsed.warnings).toContain('No samples available')
    request.mockResolvedValue({ status: 503, body: 'unavailable' })
    result = await getPodResourceUsage(options, pod, caller)
    expect(result.metrics.cpuUsed).toMatchObject({ total: null, error: 'Prometheus returned HTTP 503' })
    request.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        status: 'success',
        data: { resultType: 'vector', result: [{ metric: labels, value: [1, 'NaN'] }] }
      })
    })
    result = await getPodResourceUsage(options, pod, caller)
    expect(result.metrics.cpuUsed.error).toContain('non-finite')
  })

  it('discards results outside the requested pod, including history', async () => {
    const { options, request } = setup()

    request.mockImplementation(async ({ url }) => ({
      status: 200,
      body: JSON.stringify({
        status: 'success',
        data: url.pathname.endsWith('query_range')
          ? {
              resultType: 'matrix',
              result: [{ metric: { namespace: 'other', pod: 'private' }, values: [[1, '4']] }]
            }
          : { resultType: 'vector', result: [{ metric: labels, value: [1, '6'] }] }
      })
    }))
    const result = await getPodResourceUsageHistory(options, pod, caller)

    expect(result.metrics.cpuUsed.statisticsError).toContain('outside the requested pod')
    expect(JSON.stringify(result)).not.toContain('private')
  })

  it('rejects invalid identifiers and unbounded history before querying', async () => {
    const { options, request } = setup()

    await expect(getPodResourceUsage(options, { ...pod, pod: 'api"} or up' }, caller)).rejects.toThrow()
    await expect(getClusterResourceUsageHistory(options, { historySeconds: 86401 }, caller)).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
})

describe('denial-of-service guards on resource usage', () => {
  it('aligns the evaluation time so refreshes within the window ask the identical query', async () => {
    const times: string[] = []
    const { options } = setup()
    const request = options.request

    for (const offset of [1_000, 9_000]) {
      await getPodResourceUsage(
        {
          ...options,
          queryTimeAlignmentMs: 15_000,
          now: () => Date.parse('2026-10-04T10:00:00Z') + offset,
          request: async input => {
            times.push(input.url.searchParams.get('time')!)

            return request(input)
          }
        },
        pod,
        caller
      )
    }

    expect(new Set(times)).toEqual(new Set(['2026-10-04T10:00:00.000Z']))
  })

  it('charges the caller once per Prometheus query a fan-out call makes', async () => {
    const { options } = setup()
    const budget = createCallerBudget({ queriesPerMinute: 1000, maxConcurrentCalls: 1 })
    let charged = 0
    const service = new ObservabilityService({
      ...options,
      budget: {
        admit: (key, call) =>
          budget.admit(key, charge =>
            call(() => {
              charged += 1
              charge()
            })
          )
      }
    })

    await service.getPodResourceUsage(pod, caller)
    expect(charged).toBe((options.request as ReturnType<typeof vi.fn>).mock.calls.length)
    expect(charged).toBeGreaterThan(5)
  })
})
