import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HttpRequester, HttpResponse } from './observability-http.js'
import { createBackendGateway, createCallerBudget, GuardRefused } from './backend-guard.js'

const ok: HttpResponse = { status: 200, body: '{"status":"success"}' }
const query = (q = 'up') => new URL(`http://prometheus:9090/api/v1/query?query=${q}`)
const loki = new URL('http://loki:3100/loki/api/v1/query_range?query=%7Bpod%3D%22a%22%7D')

function deferred() {
  let resolve!: (response: HttpResponse) => void
  const promise = new Promise<HttpResponse>(res => (resolve = res))

  return { promise, resolve }
}

async function refusal(promise: Promise<unknown>): Promise<GuardRefused> {
  try {
    await promise
  } catch (error) {
    if (error instanceof GuardRefused) return error

    throw error
  }

  throw new Error('expected a refusal')
}

describe('createBackendGateway', () => {
  afterEach(() => vi.useRealTimers())

  function gateway(overrides: Partial<Parameters<typeof createBackendGateway>[0]> = {}) {
    let clock = 0
    const request = vi.fn<HttpRequester>().mockResolvedValue(ok)
    const outcomes: string[] = []
    const guarded = createBackendGateway({
      request,
      prometheusUrl: 'http://prometheus:9090',
      maxConcurrent: 2,
      maxQueued: 1,
      queueWaitMs: 1000,
      cacheTtlMs: 15_000,
      prometheusTimeoutSeconds: 9,
      onOutcome: outcome => outcomes.push(outcome),
      now: () => clock,
      ...overrides
    })

    return { guarded, request, outcomes, advance: (ms: number) => (clock += ms) }
  }

  it("adds Prometheus's own timeout to queries, and only to queries", async () => {
    const { guarded, request } = gateway()

    await guarded({ url: query() })
    await guarded({ url: loki })
    expect(request.mock.calls[0][0].url.searchParams.get('timeout')).toBe('9s')
    expect(request.mock.calls[1][0].url.searchParams.has('timeout')).toBe(false)
  })

  it('answers an identical Prometheus query from the cache until it expires, never caching failures', async () => {
    const { guarded, request, outcomes, advance } = gateway()

    await guarded({ url: query() })
    await guarded({ url: query() })
    expect(request).toHaveBeenCalledOnce()
    advance(15_001)
    await guarded({ url: query() })
    expect(request).toHaveBeenCalledTimes(2)

    request.mockResolvedValueOnce({ status: 503, body: 'overloaded' })
    await guarded({ url: query('down') })
    await guarded({ url: query('down') })
    expect(request).toHaveBeenCalledTimes(4)
    expect(outcomes).toEqual(['ok', 'cached', 'ok', 'ok', 'ok'])
  })

  it('does not cache Loki, but shares an identical request already in flight', async () => {
    const { guarded, request, outcomes } = gateway()
    const held = deferred()

    request.mockReturnValueOnce(held.promise)
    const first = guarded({ url: loki })
    const second = guarded({ url: loki })

    held.resolve(ok)
    await Promise.all([first, second])
    await guarded({ url: loki })
    expect(request).toHaveBeenCalledTimes(2)
    expect(outcomes).toEqual(['shared', 'ok', 'ok'])
  })

  it('queues briefly beyond the concurrency ceiling, then refuses instead of piling up', async () => {
    const { guarded, request } = gateway({ cacheTtlMs: 0 })
    const held = [deferred(), deferred(), deferred()]

    request
      .mockReturnValueOnce(held[0].promise)
      .mockReturnValueOnce(held[1].promise)
      .mockReturnValueOnce(held[2].promise)
    const running = [guarded({ url: query('a') }), guarded({ url: query('b') })]
    const queued = guarded({ url: query('c') })

    expect((await refusal(guarded({ url: query('d') }))).reason).toBe('busy')
    expect(request).toHaveBeenCalledTimes(2)

    held[0].resolve(ok)
    await running[0]
    // The freed slot went straight to the queued request.
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3))
    held[1].resolve(ok)
    held[2].resolve(ok)
    await Promise.all([running[1], queued])
  })

  it('refuses a queued request that waits past its deadline', async () => {
    vi.useFakeTimers()
    const { guarded, request, outcomes } = gateway({ cacheTtlMs: 0, maxConcurrent: 1 })
    const held = deferred()

    request.mockReturnValueOnce(held.promise)
    const running = guarded({ url: query('a') })
    const queued = refusal(guarded({ url: query('b') }))

    await vi.advanceTimersByTimeAsync(1001)
    expect((await queued).reason).toBe('busy')
    held.resolve(ok)
    await running
    expect(outcomes).toEqual(['busy', 'ok'])
  })
})

describe('createCallerBudget', () => {
  it('charges each backend request, so a fan-out call pays for every query it makes', async () => {
    let now = 0
    const budget = createCallerBudget({ queriesPerMinute: 10, maxConcurrentCalls: 5, now: () => now })

    await budget.admit('alice', async charge => {
      for (let index = 0; index < 12; index++) charge()
    })

    // 10 - 12 = -2: the next query needs 3 more tokens, 18 s at 10 per minute.
    const refused = await refusal(budget.admit('alice', async () => 'x'))

    expect(refused.reason).toBe('rate_limited')
    expect(refused.retryAfterSeconds).toBe(18)
    await expect(budget.admit('bob', async () => 'own budget')).resolves.toBe('own budget')
    now += 18_000
    await expect(budget.admit('alice', async () => 'refilled')).resolves.toBe('refilled')
  })

  it('caps the calls one caller has in flight and releases on failure', async () => {
    const budget = createCallerBudget({ queriesPerMinute: 0, maxConcurrentCalls: 1 })
    let release!: () => void
    const running = budget.admit('alice', () => new Promise<void>(resolve => (release = resolve)))

    expect((await refusal(budget.admit('alice', async () => 'x'))).reason).toBe('caller_busy')
    release()
    await running
    await expect(
      budget.admit('alice', async () => {
        throw new Error('backend down')
      })
    ).rejects.toThrow('backend down')
    await expect(budget.admit('alice', async () => 'free again')).resolves.toBe('free again')
  })

  it('never forgets a caller with a call in flight when the caller table is full', async () => {
    const budget = createCallerBudget({ queriesPerMinute: 0, maxConcurrentCalls: 1, maxCallers: 1 })
    let release!: () => void
    const running = budget.admit('alice', () => new Promise<void>(resolve => (release = resolve)))

    await budget.admit('bob', async () => 'b')
    expect((await refusal(budget.admit('alice', async () => 'x'))).reason).toBe('caller_busy')
    release()
    await running
  })
})
