import { describe, expect, it, vi } from 'vitest'
import type { z } from 'zod'
import { ObservabilityService, type metricsInput } from './observability-service.js'
import type { HttpRequester } from '../clients/observability-http.js'

const caller = { identity: { user: 'https://auth.example/#alice', groups: ['developers'] } }
const now = Date.parse('2026-09-25T12:00:00Z')
const metric = { namespace: 'team-a', metric: 'container_cpu_usage_seconds_total' }
const logs = { namespace: 'team-a', pod: 'api-1', container: 'api' }

function setup(lokiUrl: string | null = 'http://loki:3100') {
  const allowed = vi.fn().mockResolvedValue(true)
  const podLogs = vi.fn().mockResolvedValue('2026-09-25T11:55:00.123456789Z hello\n')
  const request = vi.fn<HttpRequester>().mockResolvedValue({
    status: 200,
    body: JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } })
  })
  const service = new ObservabilityService({
    prometheusUrl: 'http://prometheus:9090',
    lokiUrl,
    kubernetes: { allowed, podLogs },
    request,
    now: () => now
  })

  return { service, allowed, podLogs, request }
}

describe('observability authorization', () => {
  it('checks namespace-scoped Kubernetes RBAC without needing a tenancy claim', async () => {
    const { service, allowed, request } = setup()

    await service.queryMetrics(metric, caller)
    expect(allowed).toHaveBeenCalledWith(caller.identity, {
      namespace: 'team-a',
      group: '',
      resource: 'pods',
      verb: 'list'
    })
    expect(request).toHaveBeenCalledOnce()
  })

  it('checks the exact pod log resource before Kubernetes reads', async () => {
    const { service, allowed, podLogs } = setup(null)

    await service.queryLogs(logs, caller)
    expect(allowed).toHaveBeenCalledWith(caller.identity, {
      namespace: 'team-a',
      group: '',
      resource: 'pods',
      subresource: 'log',
      name: 'api-1',
      verb: 'get'
    })
    expect(podLogs).toHaveBeenCalledOnce()
  })

  it.each(['deny', 'error', 'missing'] as const)('fails closed on %s for both data sources', async mode => {
    const { service, allowed, request, podLogs } = setup(null)

    if (mode === 'deny') allowed.mockResolvedValue(false)

    if (mode === 'error') allowed.mockRejectedValue(new Error('review unavailable'))

    const identity = mode === 'missing' ? undefined : caller

    await expect(service.queryMetrics(metric, identity)).rejects.toThrow()
    await expect(service.queryLogs(logs, identity)).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
    expect(podLogs).not.toHaveBeenCalled()
  })

  it('never contacts Loki after a denial', async () => {
    const { service, allowed, request } = setup()

    allowed.mockResolvedValue(false)
    await expect(service.queryLogs(logs, caller)).rejects.toThrow('RBAC denied')
    expect(request).not.toHaveBeenCalled()
  })

  it('does not reuse authorization across callers or namespaces', async () => {
    const { service, allowed, request } = setup()

    allowed.mockImplementation(async identity => identity.user === caller.identity.user)
    const other = { identity: { user: 'bob', groups: [] } }
    const results = await Promise.allSettled([
      service.queryMetrics(metric, caller),
      service.queryMetrics({ ...metric, namespace: 'team-b' }, other)
    ])

    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(allowed).toHaveBeenCalledTimes(2)
    expect(request).toHaveBeenCalledOnce()
  })
})

describe('Prometheus query construction', () => {
  it('constructs a scoped range query, retaining namespace through aggregation', async () => {
    const { service, request } = setup()

    await service.queryMetrics(
      {
        ...metric,
        operation: 'rate',
        windowSeconds: 300,
        aggregate: 'sum',
        groupBy: ['pod'],
        labels: { container: 'api' },
        start: '2026-09-25T11:00:00Z',
        end: '2026-09-25T12:00:00Z'
      },
      caller
    )
    const url = request.mock.calls[0][0].url

    expect(url.pathname).toBe('/api/v1/query_range')
    expect(url.searchParams.get('query')).toBe(
      'sum by (namespace,pod) (rate(container_cpu_usage_seconds_total{namespace="team-a",container="api"}[300s]))'
    )
    expect(url.searchParams.get('step')).toBe('60')
    expect(url.searchParams.get('limit')).toBe('100')
  })

  it('escapes label values as literals', async () => {
    const { service, request } = setup()
    const injection = '"} or up{namespace="other"}\n\\'

    await service.queryMetrics({ ...metric, labels: { pod: injection } }, caller)
    expect(request.mock.calls[0][0].url.searchParams.get('query')).toBe(
      `container_cpu_usage_seconds_total{namespace="team-a",pod=${JSON.stringify(injection)}}`
    )
  })

  it.each<Partial<z.input<typeof metricsInput>>>([
    { metric: 'up or secret' },
    { namespace: '.*' },
    { labels: { namespace: 'other' } },
    { labels: { __name__: 'secret' } },
    { labels: { 'pod=~': '.*' } },
    { groupBy: ['pod) (up)'] },
    { start: '2026-09-25T11:00:00Z' },
    { start: '2026-09-01T00:00:00Z', end: '2026-09-25T00:00:00Z' },
    { start: '2026-09-25T00:00:00Z', end: '2026-09-24T00:00:00Z' },
    { limit: 1001 },
    { groupBy: ['pod'] }
  ])('rejects unsafe or unbounded inputs: %j', async override => {
    const { service, allowed, request } = setup()

    await expect(service.queryMetrics({ ...metric, ...override }, caller)).rejects.toThrow()
    expect(allowed).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects unexpected namespaces returned by the backend', async () => {
    const { service, request } = setup()

    request.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ metric: { namespace: 'other' }, value: [1, '42'] }]
        }
      })
    })
    await expect(service.queryMetrics(metric, caller)).rejects.toThrow('outside the requested namespace')
  })

  it('preserves samples and upstream warnings', async () => {
    const { service, request } = setup()
    const series = { metric: { namespace: 'team-a' }, value: [1, '42'] }

    request.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [series]
        },
        warnings: ['partial data']
      })
    })
    expect(await service.queryMetrics(metric, caller)).toMatchObject({
      result: [series],
      warnings: ['partial data']
    })
  })
})

describe('log source selected by LOKI_URL', () => {
  it('uses Loki with exact namespace, pod and container matchers', async () => {
    const { service, request, podLogs } = setup()
    const streams = [{ stream: logs, values: [['1790337300000000000', 'hello']] }]

    request.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ status: 'success', data: { resultType: 'streams', result: streams } })
    })
    const result = await service.queryLogs({ ...logs, contains: '" or {namespace="other"}' }, caller)

    expect(result).toMatchObject({ source: 'loki', streams })
    const url = request.mock.calls[0][0].url

    expect(url.pathname).toBe('/loki/api/v1/query_range')
    expect(url.searchParams.get('query')).toBe(
      `{namespace="team-a",pod="api-1",container="api"} |= ${JSON.stringify('" or {namespace="other"}')}`
    )
    expect(url.searchParams.get('end')).toBe(String(BigInt(now) * 1000000n))
    expect(podLogs).not.toHaveBeenCalled()
  })

  it.each([400, 401, 403, 429, 500, 503])('returns Loki HTTP %s without switching sources', async status => {
    const { service, request, podLogs } = setup()

    request.mockResolvedValue({ status, body: '' })
    await expect(service.queryLogs(logs, caller)).rejects.toThrow(`Loki returned HTTP ${status}`)
    expect(podLogs).not.toHaveBeenCalled()
  })

  it('does not switch sources on connection failure or malformed/empty responses', async () => {
    const { service, request, podLogs } = setup()

    request.mockRejectedValueOnce(new Error('timeout'))
    await expect(service.queryLogs(logs, caller)).rejects.toThrow('timeout')
    request.mockResolvedValueOnce({ status: 200, body: 'invalid' })
    await expect(service.queryLogs(logs, caller)).rejects.toThrow()
    request.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ status: 'success', data: { resultType: 'streams', result: [] } })
    })
    expect(await service.queryLogs(logs, caller)).toMatchObject({ source: 'loki', streams: [] })
    expect(podLogs).not.toHaveBeenCalled()
  })

  it('uses bounded Kubernetes logs only when Loki is unset', async () => {
    const { service, request, podLogs } = setup(null)

    podLogs.mockResolvedValue(
      [
        '2026-09-25T10:00:00Z too old',
        '2026-09-25T11:50:00.123456789Z hello first',
        '2026-09-25T11:55:00Z goodbye',
        '2026-09-25T11:59:00Z hello last',
        '2026-09-25T12:01:00Z hello too new',
        ''
      ].join('\n')
    )
    const result = await service.queryLogs({ ...logs, contains: 'hello', limit: 25 }, caller)

    expect(result).toMatchObject({
      source: 'kubernetes',
      entries: [
        { timestamp: '2026-09-25T11:59:00Z', line: 'hello last' },
        { timestamp: '2026-09-25T11:50:00.123456789Z', line: 'hello first' }
      ]
    })
    const [namespace, pod, parameters] = podLogs.mock.calls[0]

    expect([namespace, pod]).toEqual(['team-a', 'api-1'])
    expect(Object.fromEntries(parameters)).toMatchObject({
      timestamps: 'true',
      sinceTime: '2026-09-25T11:00:00.000Z',
      tailLines: '25',
      limitBytes: '1048576',
      container: 'api',
      follow: 'false'
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects streams from an unexpected namespace or pod', async () => {
    const { service, request } = setup()

    request.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        status: 'success',
        data: {
          resultType: 'streams',
          result: [{ stream: { ...logs, namespace: 'other' }, values: [] }]
        }
      })
    })
    await expect(service.queryLogs(logs, caller)).rejects.toThrow('outside the requested scope')
  })
})
