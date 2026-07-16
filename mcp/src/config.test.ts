import { describe, expect, it } from 'vitest'
import { loadAppConfig } from './config.js'

const SOURCE_VALUES: Record<string, unknown> = {
  'database.path': '/data/driftmower-be.sqlite',
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
      databasePath: '/data/driftmower-be.sqlite',
      transport: 'stdio',
      port: 3000,
      defaultLimit: 20,
      maximumLimit: 100
    })
  })

  it('gives the database CLI argument precedence over config values', () => {
    const result = loadAppConfig(['--db', '/tmp/override.sqlite'], source)

    expect(result).toMatchObject({
      databasePath: '/tmp/override.sqlite',
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
    ).toThrow(
      'defaultLimit must be an integer between 1 and 10'
    )
  })

  it('rejects an empty database path', () => {
    expect(() => loadAppConfig(['--db', '   '], source)).toThrow('databasePath must be a non-empty string')
  })

  it('rejects unsupported or malformed CLI options', () => {
    expect(() => loadAppConfig(['--transport', 'http'], source)).toThrow("unknown option '--transport'")
    expect(() => loadAppConfig(['--db'], source)).toThrow("option '--db <path>' argument missing")
  })
})
