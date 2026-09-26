import config from 'config'
import { Command } from 'commander'
import { clusterIdentity, type ClusterIdentity } from './domain/cluster-identity.js'

const TRANSPORTS = ['stdio', 'http'] as const
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

export interface OidcConfig {
  issuer: string
  jwksUri: string
  // Null means "use the resource this server advertises", which is what a
  // conformant client asks for. See BearerAuthConfig.audience.
  audience: string | null
  namespacesClaim: string
}

export interface ProvisioningConfig {
  driftmowerUiUrl: string
  requestTimeoutMs: number
}

export interface AppConfig {
  backendEnabled?: boolean
  backendUrl: string
  backendServiceToken: string
  backendTimeoutMs: number
  transport: 'stdio' | 'http'
  host: string
  port: number
  healthPort: number
  defaultLimit: number
  maximumLimit: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  publicUrl: string
  cluster: ClusterIdentity
  advisoryOverrideDirectory: string | null
  oauthClientId: string | null
  // Public URL of driftmower-ui, used to bounce a browser that lands on `/`
  // over to the UI. Null means `/` stays a 404. This is deliberately separate
  // from `provisioning.driftmowerUiUrl`, which is the cluster-internal Service
  // a browser cannot resolve.
  uiPublicUrl: string | null
  // Bearer verification on the HTTP transport. Ignored by stdio, which is a
  // local process with no network surface.
  authEnabled: boolean
  // Present only when authentication is on; the loader refuses to start an
  // authenticated HTTP server without it rather than silently serving open.
  oidc: OidcConfig | null
  // Present only when a driftmower-ui base URL is configured. Absent means the
  // provisioning tools are not registered at all, which is a clearer failure
  // than registering tools that always error.
  provisioning: ProvisioningConfig | null
  kubernetes: KubernetesConfig
  observability?: ObservabilityConfig | null
}

export interface ObservabilityConfig {
  prometheusUrl: string | null
  lokiUrl: string | null
  requestTimeoutMs: number
}

export interface KubernetesConfig {
  namespaceRole: string
  url: string
  tokenFile: string
  caFile: string
  usernamePrefix: string
  groupsPrefix: string
  requestTimeoutMs: number
}

interface ConfigSource {
  get<T>(key: string): T
}

interface CliOptions {
  backendUrl?: string
}

function parseCliArguments(arguments_: string[]): CliOptions {
  const command = new Command()
    .name('driftmower-mcp')
    .description('Expose persisted Driftmower analysis over MCP')
    .helpOption(false)
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeErr: () => undefined })
    .option('--backend-url <url>', 'base URL of the driftmower-be API')

  command.parse(arguments_, { from: 'user' })

  return command.opts<CliOptions>()
}

function readString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }

  return value.trim()
}

function readUrl(value: unknown, name: string): string {
  const url = readString(value, name)

  try {
    new URL(url)
  } catch {
    throw new Error(`${name} must be an absolute URL`)
  }

  return url.replace(/\/+$/, '')
}

function readOptionalUrl(value: unknown, name: string): string | null {
  if (readOptionalString(value) === null) {
    return null
  }

  return readUrl(value, name)
}

function readInteger(value: unknown, name: string, maximum?: number): number {
  const parsedValue = typeof value === 'number' ? value : Number(value)

  if (!Number.isInteger(parsedValue) || parsedValue < 1 || (maximum && parsedValue > maximum)) {
    throw new Error(`${name} must be an integer between 1 and ${maximum ?? 'the supported maximum'}`)
  }

  return parsedValue
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  return value.trim()
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'string') {
    return value.trim().toLowerCase() !== 'false'
  }

  return fallback
}

function readEnum<const Values extends readonly string[]>(
  value: unknown,
  name: string,
  allowedValues: Values
): Values[number] {
  if (typeof value !== 'string' || !allowedValues.includes(value)) {
    throw new Error(`${name} must be one of: ${allowedValues.join(', ')}`)
  }

  return value as Values[number]
}

export function loadAppConfig(
  arguments_: string[] = process.argv.slice(2),
  source: ConfigSource = config
): AppConfig {
  const cli = parseCliArguments(arguments_)
  const maximumLimit = readInteger(source.get<number>('search.maximumLimit'), 'maximumLimit')
  const defaultLimit = readInteger(source.get<number>('search.defaultLimit'), 'defaultLimit', maximumLimit)
  const transport = readEnum(source.get<string>('mcp.transport'), 'transport', TRANSPORTS)
  const authEnabled = readBoolean(source.get<unknown>('mcp.authEnabled'), true)
  const port = readInteger(source.get<number>('mcp.port'), 'port', 65_535)
  const backendEnabled = readBoolean(source.get<unknown>('backend.enabled'), true)
  const publicUrl =
    readOptionalUrl(source.get<unknown>('mcp.publicUrl'), 'MCP_PUBLIC_URL') ?? `http://127.0.0.1:${port}`

  validateServiceUrl(publicUrl)

  const id = readOptionalString(source.get<unknown>('cluster.id'))
  const apiUrl = readOptionalUrl(source.get<unknown>('cluster.apiUrl'), 'KUBERNETES_PUBLIC_API_URL')

  if (id && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(id)) {
    throw new Error(
      'DRIFTMOWER_CLUSTER_ID must be a lowercase DNS-style cluster identifier, including the provider domain'
    )
  }

  if (apiUrl) {
    validateServiceUrl(apiUrl)

    if (new URL(apiUrl).protocol !== 'https:') throw new Error('KUBERNETES_PUBLIC_API_URL must use HTTPS')
  }

  const oidc = transport === 'http' && authEnabled ? readOidcConfig(source) : null

  return {
    backendEnabled,
    backendUrl: readUrl(cli.backendUrl ?? source.get<string>('backend.url'), 'backendUrl'),
    // The backend rejects an unauthenticated read, so an empty token is a
    // misconfiguration worth failing on at startup rather than on first tool call.
    backendServiceToken: backendEnabled
      ? readString(source.get<string>('backend.serviceToken'), 'backendServiceToken')
      : '',
    backendTimeoutMs: readInteger(source.get<number>('backend.timeoutMs'), 'backendTimeoutMs'),
    transport,
    // Defaults to `::`, which serves IPv6 and IPv4 clients from one socket
    // wherever the OS leaves bindv6only off — a client that resolves
    // `localhost` to `::1` reaches the same server as one that picks
    // `127.0.0.1`. Narrow it to `::1` or `127.0.0.1` to bind loopback only.
    host: readString(source.get<string>('mcp.host'), 'host'),
    port,
    healthPort: readInteger(source.get<number>('mcp.healthPort'), 'healthPort', 65_535),
    defaultLimit,
    maximumLimit,
    logLevel: readEnum(source.get<string>('mcp.logLevel'), 'logLevel', LOG_LEVELS),
    publicUrl,
    cluster: clusterIdentity(id, apiUrl, publicUrl),
    advisoryOverrideDirectory: readOptionalString(source.get<unknown>('advisory.overrideDirectory')),
    oauthClientId: readOptionalString(source.get<unknown>('mcp.oauthClientId')),
    uiPublicUrl: readOptionalUrl(source.get<string>('mcp.uiPublicUrl'), 'uiPublicUrl'),
    authEnabled,
    oidc,
    provisioning: readProvisioningConfig(source),
    kubernetes: readKubernetesConfig(source, oidc),
    observability: readObservabilityConfig(source, oidc)
  }
}

function readObservabilityConfig(source: ConfigSource, oidc: OidcConfig | null): ObservabilityConfig | null {
  const prometheusUrl = readOptionalUrl(source.get<unknown>('observability.prometheusUrl'), 'PROMETHEUS_URL')
  const lokiUrl = readOptionalUrl(source.get<unknown>('observability.lokiUrl'), 'LOKI_URL')

  if (!prometheusUrl && !lokiUrl && !readBoolean(source.get<unknown>('observability.enabled'), false))
    return null

  if (!oidc) throw new Error('Observability tools require authenticated HTTP transport and OIDC_ISSUER')

  for (const url of [prometheusUrl, lokiUrl]) {
    if (url) validateServiceUrl(url)
  }

  return {
    prometheusUrl,
    lokiUrl,
    requestTimeoutMs: readInteger(
      source.get<unknown>('observability.requestTimeoutMs'),
      'OBSERVABILITY_TIMEOUT_MS'
    )
  }
}

function validateServiceUrl(url: string): void {
  const parsed = new URL(url)

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Service URLs must use HTTP(S) without credentials, query strings or fragments')
  }
}

function readKubernetesConfig(source: ConfigSource, oidc: OidcConfig | null): KubernetesConfig {
  const url = readUrl(source.get<unknown>('kubernetes.url'), 'KUBERNETES_API_URL')

  validateServiceUrl(url)

  if (new URL(url).protocol !== 'https:') throw new Error('KUBERNETES_API_URL must use HTTPS')

  const prefix = readOptionalString(source.get<unknown>('kubernetes.usernamePrefix'))

  return {
    url,
    tokenFile: readString(source.get<unknown>('kubernetes.tokenFile'), 'KUBERNETES_TOKEN_FILE'),
    caFile: readString(source.get<unknown>('kubernetes.caFile'), 'KUBERNETES_CA_FILE'),
    usernamePrefix: prefix === '-' ? '' : (prefix ?? (oidc ? `${oidc.issuer}#` : '')),
    groupsPrefix: readOptionalString(source.get<unknown>('kubernetes.groupsPrefix')) ?? '',
    namespaceRole: readOptionalString(source.get<unknown>('kubernetes.namespaceRole')) ?? 'admin',
    requestTimeoutMs: readInteger(source.get<unknown>('kubernetes.requestTimeoutMs'), 'KUBERNETES_TIMEOUT_MS')
  }
}

// Refusing to start beats starting open. An HTTP server published on an ingress
// with authEnabled defaulting true and no issuer configured would otherwise
// have to choose between serving unauthenticated and rejecting every call; both
// are worse than a startup error naming the missing variable.
function readOidcConfig(source: ConfigSource): OidcConfig {
  const issuer = readOptionalString(source.get<string>('oidc.issuer'))

  if (!issuer) {
    throw new Error(
      'OIDC_ISSUER is required when the HTTP transport runs with authentication ' +
        '(set MCP_AUTH_ENABLED=false only for a server that is not reachable from outside the cluster)'
    )
  }

  return {
    issuer,
    jwksUri: readOptionalString(source.get<string>('oidc.jwksUri')) ?? `${issuer.replace(/\/+$/, '')}/jwks`,
    audience: readOptionalString(source.get<string>('oidc.audience')),
    namespacesClaim: readString(source.get<string>('oidc.namespacesClaim'), 'namespacesClaim')
  }
}

function readProvisioningConfig(source: ConfigSource): ProvisioningConfig | null {
  const driftmowerUiUrl = readOptionalString(source.get<string>('provisioning.driftmowerUiUrl'))

  if (!driftmowerUiUrl) {
    return null
  }

  return {
    driftmowerUiUrl: driftmowerUiUrl.replace(/\/+$/, ''),
    requestTimeoutMs: readInteger(source.get<number>('provisioning.requestTimeoutMs'), 'requestTimeoutMs')
  }
}
