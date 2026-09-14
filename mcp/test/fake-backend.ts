import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DriftmowerBackendClient } from '../src/backend/client.js'

// A stand-in for driftmower-be that answers from recorded rows.
//
// It is deliberately strict about what it accepts: each service declares the
// same query and select properties as its Feathers schema does, and anything
// else is a 400. A query this fake rejects is a query the real backend would
// reject too, which is the point of testing against it.
const QUERY_PROPERTIES: Record<string, string[]> = {
  reports: ['id', 'sourceType', 'status', 'clusterContext', 'createdAt', 'reportHash', 'namespaceScope'],
  'image-usages': ['reportId', 'workloadGroupKey', 'releaseGroupKey', 'status', 'registry', 'repository'],
  'release-scores': ['reportId', 'groupKey']
}

// Matches the backend's paginate.max: a client asking for more gets this.
const MAXIMUM_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 100

type Row = Record<string, unknown>

export interface FakeBackendOptions {
  serviceToken?: string
  rows?: Partial<Record<string, Row[]>>
}

export interface FakeBackend {
  client: DriftmowerBackendClient
  // Every path+query the client asked for, in order.
  requests: string[]
}

export function loadFixtureRows(): Record<string, Row[]> {
  return {
    reports: readFixture('reports.json'),
    'image-usages': readFixture('image-usages.json'),
    'release-scores': readFixture('release-scores.json')
  }
}

export function createFakeBackend(options: FakeBackendOptions = {}): FakeBackend {
  const serviceToken = options.serviceToken ?? 'dm_svc_test'
  const rows = { ...loadFixtureRows(), ...options.rows }
  const requests: string[] = []

  const fetchImplementation = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))

    requests.push(`${url.pathname}${url.search}`)

    const authorization = new Headers(init?.headers).get('authorization')

    if (authorization !== `Bearer ${serviceToken}`) {
      return jsonResponse(401, { name: 'NotAuthenticated', message: 'Invalid service token' })
    }

    const path = url.pathname.replace(/^\//, '')
    const serviceRows = rows[path]

    if (!serviceRows) {
      return jsonResponse(404, { name: 'NotFound', message: `No service '${path}'` })
    }

    try {
      return jsonResponse(200, findRows(path, serviceRows, url.searchParams))
    } catch (error) {
      return jsonResponse(400, {
        name: 'BadRequest',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }) as typeof fetch

  return {
    client: new DriftmowerBackendClient({
      baseUrl: 'http://driftmower-be.test',
      serviceToken,
      fetchImplementation
    }),
    requests
  }
}

function findRows(path: string, rows: Row[], parameters: URLSearchParams): unknown {
  const allowed = QUERY_PROPERTIES[path]
  const filters: Array<[string, string]> = []
  let select: string[] | null = null
  let sortField: string | null = null
  let sortDirection = 1
  let limit = DEFAULT_PAGE_SIZE
  let skip = 0

  for (const [key, value] of parameters.entries()) {
    const selectMatch = /^\$select\[\d+]$/.exec(key)
    const sortMatch = /^\$sort\[([^\]]+)]$/.exec(key)

    if (selectMatch) {
      assertAllowed(path, value, allowed)
      select = [...(select ?? []), value]
    } else if (sortMatch) {
      assertAllowed(path, sortMatch[1], allowed)
      sortField = sortMatch[1]
      sortDirection = Number(value) < 0 ? -1 : 1
    } else if (key === '$limit') {
      limit = Math.min(Number(value), MAXIMUM_PAGE_SIZE)
    } else if (key === '$skip') {
      skip = Number(value)
    } else {
      assertAllowed(path, key, allowed)
      filters.push([key, value])
    }
  }

  const matched = rows.filter(row => filters.every(([field, value]) => String(row[field]) === value))
  const sorted = sortField === null ? matched : [...matched].sort(compareBy(sortField, sortDirection))
  const page = sorted.slice(skip, skip + limit)

  return {
    total: matched.length,
    limit,
    skip,
    data: select === null ? page : page.map(row => project(row, select))
  }
}

// The backend's result resolver builds the response out of the selected
// properties only, so an unselected field — `id` included — is simply absent.
function project(row: Row, select: string[]): Row {
  return Object.fromEntries(select.filter(field => field in row).map(field => [field, row[field]]))
}

function assertAllowed(path: string, property: string, allowed: string[] | undefined): void {
  if (allowed && !allowed.includes(property)) {
    throw new Error(`Query for '${path}' does not allow property '${property}'`)
  }
}

function compareBy(field: string, direction: number) {
  return (left: Row, right: Row): number => {
    const leftValue = String(left[field] ?? '')
    const rightValue = String(right[field] ?? '')

    if (leftValue === rightValue) {
      return 0
    }

    return (leftValue < rightValue ? -1 : 1) * direction
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function readFixture(name: string): Row[] {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/backend/${name}`, import.meta.url)), 'utf8'))
}
