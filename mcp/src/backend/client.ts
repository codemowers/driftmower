// HTTP client for driftmower-be's Feathers REST API.
//
// This is the only place that knows the backend speaks Feathers: the query
// syntax (`$limit`, `$skip`, `$sort`, `$select`, `field[$in][]=`), the
// paginated envelope, and the service-token credential. Everything above it
// works with plain rows.
const DEFAULT_PAGE_SIZE = 100
const DEFAULT_TIMEOUT_MS = 15_000
// A cluster report holds one row per container, so paging has to cope with
// thousands of rows while still refusing to loop forever on a backend that
// reports a total it never reaches.
const MAXIMUM_PAGES = 200

export interface BackendClientOptions {
  baseUrl: string
  serviceToken: string
  timeoutMs?: number
  pageSize?: number
  fetchImplementation?: typeof fetch
}

export type QueryValue = string | number | boolean | null | undefined | QueryValue[] | QueryObject

export interface QueryObject {
  [key: string]: QueryValue
}

interface PaginatedResponse<Row> {
  total: number
  limit: number
  skip: number
  data: Row[]
}

export class BackendRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null
  ) {
    super(message)
    this.name = 'BackendRequestError'
  }
}

export class DriftmowerBackendClient {
  private readonly baseUrl: string
  private readonly serviceToken: string
  private readonly timeoutMs: number
  private readonly pageSize: number
  private readonly fetchImplementation: typeof fetch

  constructor(options: BackendClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.serviceToken = options.serviceToken
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
    this.fetchImplementation = options.fetchImplementation ?? globalThis.fetch
  }

  // Reads one page. Callers that need every row should use findAll instead of
  // raising $limit: the backend caps a page at its own paginate.max.
  async findPage<Row>(path: string, query: QueryObject = {}): Promise<PaginatedResponse<Row>> {
    const url = `${this.baseUrl}/${path}${buildQueryString(query)}`
    const response = await this.request(url)
    const body = (await readJson(response, url)) as PaginatedResponse<Row> | Row[]

    // `paginate: false` responses are bare arrays; normalise them so callers
    // never have to care which shape came back.
    if (Array.isArray(body)) {
      return { total: body.length, limit: body.length, skip: 0, data: body }
    }

    if (!Array.isArray(body?.data)) {
      throw new BackendRequestError(`Unexpected response shape from ${url}`)
    }

    return body
  }

  async findAll<Row>(path: string, query: QueryObject = {}): Promise<Row[]> {
    const rows: Row[] = []
    let skip = 0

    for (let page = 0; page < MAXIMUM_PAGES; page += 1) {
      const result = await this.findPage<Row>(path, { ...query, $limit: this.pageSize, $skip: skip })

      rows.push(...result.data)

      // An empty page ends the scan even when `total` disagrees, so a backend
      // that miscounts cannot spin this loop.
      if (result.data.length === 0 || rows.length >= result.total) {
        return rows
      }

      skip += result.data.length
    }

    throw new BackendRequestError(`Refusing to read more than ${MAXIMUM_PAGES} pages from ${path}`)
  }

  private async request(url: string): Promise<Response> {
    let response: Response

    try {
      response = await this.fetchImplementation(url, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.serviceToken}`
        },
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (error) {
      throw new BackendRequestError(`Request to ${url} failed: ${errorMessage(error)}`)
    }

    if (!response.ok) {
      throw new BackendRequestError(
        `Request to ${url} failed with ${response.status}: ${await readErrorBody(response)}`,
        response.status
      )
    }

    return response
  }
}

async function readJson(response: Response, url: string): Promise<unknown> {
  try {
    return await response.json()
  } catch (error) {
    throw new BackendRequestError(`Response from ${url} was not JSON: ${errorMessage(error)}`)
  }
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text()

    return text.slice(0, 500) || response.statusText
  } catch {
    return response.statusText
  }
}

// Serialises a query the way the backend's `qs` parser reads it back:
// nested objects and arrays become bracketed keys (`$sort[createdAt]=-1`,
// `$select[0]=id`). Undefined values are dropped so callers can pass optional
// filters without building the object conditionally.
export function buildQueryString(query: QueryObject): string {
  const parameters = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    appendQueryValue(parameters, key, value)
  }

  const serialized = parameters.toString()

  return serialized.length > 0 ? `?${serialized}` : ''
}

function appendQueryValue(parameters: URLSearchParams, key: string, value: QueryValue): void {
  if (value === undefined) {
    return
  }

  if (value === null) {
    parameters.append(key, '')

    return
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => appendQueryValue(parameters, `${key}[${index}]`, entry))

    return
  }

  if (typeof value === 'object') {
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      appendQueryValue(parameters, `${key}[${nestedKey}]`, nestedValue)
    }

    return
  }

  parameters.append(key, String(value))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
