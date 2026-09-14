import { describe, expect, it } from 'vitest'
import { loadAppConfig } from './config.js'

const SOURCE_VALUES: Record<string, unknown> = {
  'backend.url': 'http://driftmower-be:3030',
  'backend.serviceToken': 'dm_svc_token',
  'backend.timeoutMs': 15_000,
  'mcp.transport': 'stdio',
  'mcp.host': '127.0.0.1',
  'mcp.port': 3000,
  'mcp.healthPort': 3001,
  'mcp.logLevel': 'info',
  'search.defaultLimit': 20,
  'search.maximumLimit': 100
}

const source = {
  get<T>(key: string): T {
    return SOURCE_VALUES[key] as T
  }
}

function sourceWith(overrides: Record<string, unknown>) {
  return {
    get<T>(key: string): T {
      return (key in overrides ? overrides[key] : SOURCE_VALUES[key]) as T
    }
  }
}

describe('loadAppConfig', () => {
  it('loads config source values', () => {
    expect(loadAppConfig([], source)).toMatchObject({
      backendUrl: 'http://driftmower-be:3030',
      backendServiceToken: 'dm_svc_token',
      backendTimeoutMs: 15_000,
      transport: 'stdio',
      port: 3000,
      defaultLimit: 20,
      maximumLimit: 100
    })
  })

  it('gives the backend URL CLI argument precedence over config values', () => {
    const result = loadAppConfig(['--backend-url', 'http://localhost:3030/'], source)

    expect(result).toMatchObject({
      // The trailing slash is dropped so paths are appended to one known shape.
      backendUrl: 'http://localhost:3030',
      transport: 'stdio',
      port: 3000,
      defaultLimit: 20
    })
  })

  it('rejects invalid transport and limits', () => {
    expect(() => loadAppConfig([], sourceWith({ 'mcp.transport': 'websocket' }))).toThrow(
      'transport must be one of: stdio, http'
    )
    expect(() => loadAppConfig([], sourceWith({ 'search.maximumLimit': 0 }))).toThrow(
      'maximumLimit must be an integer'
    )
    expect(() =>
      loadAppConfig([], sourceWith({ 'search.maximumLimit': 10, 'search.defaultLimit': 11 }))
    ).toThrow('defaultLimit must be an integer between 1 and 10')
  })

  it('rejects a missing or relative backend URL', () => {
    expect(() => loadAppConfig(['--backend-url', '   '], source)).toThrow(
      'backendUrl must be a non-empty string'
    )
    expect(() => loadAppConfig(['--backend-url', '/reports'], source)).toThrow(
      'backendUrl must be an absolute URL'
    )
  })

  it('rejects a missing service token', () => {
    expect(() => loadAppConfig([], sourceWith({ 'backend.serviceToken': '' }))).toThrow(
      'backendServiceToken must be a non-empty string'
    )
  })

  it('rejects unsupported or malformed CLI options', () => {
    expect(() => loadAppConfig(['--transport', 'http'], source)).toThrow("unknown option '--transport'")
    expect(() => loadAppConfig(['--backend-url'], source)).toThrow(
      "option '--backend-url <url>' argument missing"
    )
  })
})
