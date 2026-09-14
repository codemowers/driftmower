import config from 'config'
import { Command } from 'commander'

export const DEFAULT_BACKEND_URL = 'http://driftmower-be:3030'

const TRANSPORTS = ['stdio', 'http'] as const
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

export interface AppConfig {
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

function readInteger(value: unknown, name: string, maximum?: number): number {
  const parsedValue = typeof value === 'number' ? value : Number(value)

  if (!Number.isInteger(parsedValue) || parsedValue < 1 || (maximum && parsedValue > maximum)) {
    throw new Error(`${name} must be an integer between 1 and ${maximum ?? 'the supported maximum'}`)
  }

  return parsedValue
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

  return {
    backendUrl: readUrl(cli.backendUrl ?? source.get<string>('backend.url'), 'backendUrl'),
    // The backend rejects an unauthenticated read, so an empty token is a
    // misconfiguration worth failing on at startup rather than on first tool call.
    backendServiceToken: readString(source.get<string>('backend.serviceToken'), 'backendServiceToken'),
    backendTimeoutMs: readInteger(source.get<number>('backend.timeoutMs'), 'backendTimeoutMs'),
    transport: readEnum(source.get<string>('mcp.transport'), 'transport', TRANSPORTS),
    host: readString(source.get<string>('mcp.host'), 'host'),
    port: readInteger(source.get<number>('mcp.port'), 'port', 65_535),
    healthPort: readInteger(source.get<number>('mcp.healthPort'), 'healthPort', 65_535),
    defaultLimit,
    maximumLimit,
    logLevel: readEnum(source.get<string>('mcp.logLevel'), 'logLevel', LOG_LEVELS)
  }
}
