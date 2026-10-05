import { clearTimeout, setTimeout } from 'node:timers'
import type { HttpRequest, HttpRequester, HttpResponse } from './observability-http.js'

// Denial-of-service guards for the shared observability backends (Prometheus,
// Loki). Every tenant's queries land on the same instances, so two layers sit
// in front of them:
//
// - a gateway around the HTTP requester: a server-wide concurrency ceiling with
//   a short bounded queue, one evaluation per identical Prometheus query
//   (in-flight sharing plus a short cache), and Prometheus's own timeout;
// - a per-caller budget around each tool call: a cap on calls in flight and a
//   token bucket charged per backend request the call makes, so a call that
//   fans out to a dozen queries pays for a dozen.
//
// Refusals are immediate and carry a retry hint; nothing waits unboundedly.

export type GuardRefusal = 'rate_limited' | 'caller_busy' | 'busy'

export class GuardRefused extends Error {
  constructor(
    readonly reason: GuardRefusal,
    readonly retryAfterSeconds: number,
    message: string
  ) {
    super(message)
    this.name = 'GuardRefused'
  }
}

// How one backend request was answered.
export type BackendOutcome = 'ok' | 'cached' | 'shared' | 'busy' | 'error'

export interface BackendGatewayOptions {
  request: HttpRequester
  // Requests under this base URL are Prometheus queries: they get its timeout
  // and may be cached. Matched by URL rather than path, since Loki's API has
  // the same /api/v1/query_range suffix.
  prometheusUrl: string | null
  // Backend requests in flight across all callers.
  maxConcurrent: number
  // Requests allowed to wait for a slot; beyond this they are refused.
  maxQueued: number
  // How long a queued request may wait for a slot.
  queueWaitMs: number
  // Successful Prometheus query answers are reused this long; 0 = off.
  cacheTtlMs: number
  // Sent as Prometheus's `timeout` so it stops evaluating when we stop waiting.
  prometheusTimeoutSeconds?: number
  maxCacheEntries?: number
  onOutcome?: (outcome: BackendOutcome) => void
  now?: () => number
}

export function createBackendGateway(options: BackendGatewayOptions): HttpRequester {
  const prometheusBase = options.prometheusUrl ? new URL(options.prometheusUrl.replace(/\/+$/, '')) : null
  const isPrometheusQueryUrl = (url: URL) =>
    prometheusBase !== null &&
    url.origin === prometheusBase.origin &&
    (url.pathname === `${prometheusBase.pathname.replace(/\/$/, '')}/api/v1/query` ||
      url.pathname === `${prometheusBase.pathname.replace(/\/$/, '')}/api/v1/query_range`)
  const now = options.now ?? Date.now
  const report = options.onOutcome ?? (() => undefined)
  const maxCacheEntries = options.maxCacheEntries ?? 1000
  const cache = new Map<string, { expiresAt: number; response: HttpResponse }>()
  const inFlight = new Map<string, Promise<HttpResponse>>()
  const waiters: { grant: () => void; timer: ReturnType<typeof setTimeout> }[] = []
  let active = 0

  function acquire(): Promise<void> {
    if (active < options.maxConcurrent) {
      active += 1

      return Promise.resolve()
    }

    if (waiters.length >= options.maxQueued) {
      return Promise.reject(
        new GuardRefused(
          'busy',
          1,
          `The observability backend is at its limit (${options.maxConcurrent} running, ${options.maxQueued} waiting); retry shortly`
        )
      )
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          clearTimeout(waiter.timer)
          resolve()
        },
        timer: setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1)
          reject(
            new GuardRefused(
              'busy',
              1,
              `The observability backend stayed at its concurrent limit for ${options.queueWaitMs} ms; retry shortly`
            )
          )
        }, options.queueWaitMs)
      }

      waiters.push(waiter)
    })
  }

  function release(): void {
    const next = waiters.shift()

    // The slot passes straight to the next waiter, so `active` is unchanged.
    if (next) next.grant()
    else active -= 1
  }

  return async (request: HttpRequest): Promise<HttpResponse> => {
    const isPrometheusQuery =
      (request.method ?? 'GET') === 'GET' && !request.body && isPrometheusQueryUrl(request.url)
    let url = request.url

    if (isPrometheusQuery && options.prometheusTimeoutSeconds && !url.searchParams.has('timeout')) {
      url = new URL(url)
      url.searchParams.set('timeout', `${options.prometheusTimeoutSeconds}s`)
    }

    const shareable = (request.method ?? 'GET') === 'GET' && !request.body
    const key = shareable ? url.toString() : null

    if (key && isPrometheusQuery && options.cacheTtlMs > 0) {
      const hit = cache.get(key)

      if (hit && hit.expiresAt > now()) {
        report('cached')

        return hit.response
      }

      if (hit) cache.delete(key)
    }

    const joined = key ? inFlight.get(key) : undefined

    if (joined) {
      report('shared')

      return joined
    }

    const pending = (async () => {
      await acquire()

      try {
        return await options.request({ ...request, url })
      } finally {
        release()
      }
    })()

    if (key) {
      inFlight.set(key, pending)
      pending.then(
        () => inFlight.delete(key),
        () => inFlight.delete(key)
      )
    }

    try {
      const response = await pending

      if (key && isPrometheusQuery && options.cacheTtlMs > 0 && response.status === 200) {
        if (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value!)

        cache.set(key, { expiresAt: now() + options.cacheTtlMs, response })
      }

      report('ok')

      return response
    } catch (error) {
      report(error instanceof GuardRefused ? 'busy' : 'error')
      throw error
    }
  }
}

export interface CallerBudgetOptions {
  // Backend requests per caller per minute; also the burst. 0 = unlimited.
  queriesPerMinute: number
  // Tool calls a caller may have in flight at once.
  maxConcurrentCalls: number
  maxCallers?: number
  now?: () => number
}

export interface CallerBudget {
  // Runs `call` if the caller is within budget. `charge` debits one backend
  // request; the balance may go negative mid-call, which delays the next call.
  admit<T>(callerKey: string, call: (charge: () => void) => Promise<T>): Promise<T>
}

interface CallerState {
  tokens: number
  refilledAt: number
  calls: number
}

export function createCallerBudget(options: CallerBudgetOptions): CallerBudget {
  const now = options.now ?? Date.now
  const maxCallers = options.maxCallers ?? 10_000
  const callers = new Map<string, CallerState>()
  const rate = options.queriesPerMinute

  function stateOf(key: string): CallerState {
    let state = callers.get(key)

    if (state) callers.delete(key)
    else {
      state = { tokens: rate, refilledAt: now(), calls: 0 }

      if (callers.size >= maxCallers) {
        for (const [oldest, candidate] of callers) {
          if (candidate.calls > 0) continue

          callers.delete(oldest)
          break
        }
      }
    }

    // Re-inserted so iteration order is least recently seen first.
    callers.set(key, state)

    if (rate > 0) {
      state.tokens = Math.min(rate, state.tokens + ((now() - state.refilledAt) * rate) / 60_000)
      state.refilledAt = now()
    }

    return state
  }

  return {
    async admit(callerKey, call) {
      const state = stateOf(callerKey)

      if (rate > 0 && state.tokens < 1) {
        const wait = Math.ceil(((1 - state.tokens) * 60_000) / rate / 1000)

        throw new GuardRefused(
          'rate_limited',
          wait,
          `Too many observability queries from this caller (limit ${rate} backend queries per minute); retry in ${wait}s`
        )
      }

      if (state.calls >= options.maxConcurrentCalls) {
        throw new GuardRefused(
          'caller_busy',
          1,
          `This caller already has ${state.calls} observability calls running (limit ${options.maxConcurrentCalls}); wait for one to finish`
        )
      }

      state.calls += 1

      try {
        return await call(() => {
          if (rate > 0) state.tokens -= 1
        })
      } finally {
        state.calls -= 1
      }
    }
  }
}
