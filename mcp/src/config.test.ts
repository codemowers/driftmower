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
  'search.maximumLimit': 100,
  'kubernetes.url': 'https://kubernetes.default.svc',
  'kubernetes.tokenFile': '/token',
  'kubernetes.caFile': '/ca',
  'kubernetes.requestTimeoutMs': 10000
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

  it('reads the driftmower-ui public URL and defaults it to null', () => {
    expect(loadAppConfig([], source).uiPublicUrl).toBeNull()
    expect(
      loadAppConfig([], sourceWith({ 'mcp.uiPublicUrl': 'https://driftmower-ui.example/' })).uiPublicUrl
    ).toBe('https://driftmower-ui.example')
    expect(() => loadAppConfig([], sourceWith({ 'mcp.uiPublicUrl': 'driftmower-ui' }))).toThrow(
      'uiPublicUrl must be an absolute URL'
    )
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

  it('allows explicitly disabling Driftmower without backend credentials', () => {
    expect(
      loadAppConfig([], sourceWith({ 'backend.enabled': false, 'backend.serviceToken': '' }))
    ).toMatchObject({ backendEnabled: false, backendServiceToken: '', observability: null })
  })

  const observability = {
    'mcp.transport': 'http',
    'oidc.issuer': 'https://auth.example/',
    'oidc.namespacesClaim': 'codemowers.io/namespaces',
    'observability.prometheusUrl': 'http://prometheus:9090/',
    'kubernetes.url': 'https://kubernetes.default.svc',
    'kubernetes.tokenFile': '/token',
    'kubernetes.caFile': '/ca',
    'observability.requestTimeoutMs': 10000
  }

  it('loads standalone observability configuration and default OIDC identity mapping', () => {
    const result = loadAppConfig(
      [],
      sourceWith({ ...observability, 'backend.enabled': false, 'backend.serviceToken': '' })
    )

    expect(result.observability).toMatchObject({
      prometheusUrl: 'http://prometheus:9090',
      lokiUrl: null
    })
    expect(result.kubernetes).toMatchObject({
      usernamePrefix: 'https://auth.example/#',
      namespaceRole: 'admin',
      groupsPrefix: ''
    })
  })

  it('supports Kubernetes-only logs and explicit prefix overrides', () => {
    expect(
      loadAppConfig(
        [],
        sourceWith({
          ...observability,
          'observability.prometheusUrl': '',
          'observability.enabled': true,
          'kubernetes.usernamePrefix': '-',
          'kubernetes.groupsPrefix': 'oidc:'
        })
      ).kubernetes
    ).toMatchObject({ usernamePrefix: '', groupsPrefix: 'oidc:' })
  })

  it('supports a configured namespace role name', () => {
    expect(
      loadAppConfig([], sourceWith({ ...observability, 'kubernetes.namespaceRole': 'developer' })).kubernetes
        .namespaceRole
    ).toBe('developer')
  })

  it('requires authenticated HTTP only when observability is enabled', () => {
    expect(() => loadAppConfig([], sourceWith({ ...observability, 'mcp.authEnabled': false }))).toThrow(
      'authenticated HTTP'
    )
    expect(() => loadAppConfig([], sourceWith({ ...observability, 'mcp.transport': 'stdio' }))).toThrow(
      'authenticated HTTP'
    )
    expect(loadAppConfig([], source).observability).toBeNull()
  })

  it.each(['file:///etc/passwd', 'http://user:pass@prometheus', 'http://prometheus?query=x'])(
    'rejects invalid service URL %s',
    url => {
      expect(() =>
        loadAppConfig([], sourceWith({ ...observability, 'observability.prometheusUrl': url }))
      ).toThrow('Service URLs')
    }
  )

  it('rejects unsupported or malformed CLI options', () => {
    expect(() => loadAppConfig(['--transport', 'http'], source)).toThrow("unknown option '--transport'")
    expect(() => loadAppConfig(['--backend-url'], source)).toThrow(
      "option '--backend-url <url>' argument missing"
    )
  })
})

describe('multi-cluster configuration', () => {
  it('uses a provider-qualified name and a separate external API URL', () => {
    const result = loadAppConfig(
      [],
      sourceWith({
        'cluster.id': 'ee-west-1.codemowers.io',
        'cluster.apiUrl': 'https://api.example:6443/',
        'advisory.overrideDirectory': '/etc/advisory',
        'mcp.oauthClientId': 'other-provider.mcp'
      })
    )

    expect(result.cluster).toEqual({
      id: 'ee-west-1.codemowers.io',
      apiUrl: 'https://api.example:6443',
      mcpServerName: 'driftmower-ee-west-1-codemowers-io'
    })
    expect(result.kubernetes.url).toBe('https://kubernetes.default.svc')
    expect(result.advisoryOverrideDirectory).toBe('/etc/advisory')
    expect(result.oauthClientId).toBe('other-provider.mcp')
    expect(loadAppConfig([], source).cluster.apiUrl).toBeNull()
  })

  it('rejects unsafe cluster identities and external URLs', () => {
    expect(() => loadAppConfig([], sourceWith({ 'cluster.id': 'west; echo nope' }))).toThrow(
      'DRIFTMOWER_CLUSTER_ID'
    )
    for (const url of [
      'http://api.example',
      'https://user:pass@api.example',
      'https://api.example?token=secret'
    ]) {
      expect(() => loadAppConfig([], sourceWith({ 'cluster.apiUrl': url }))).toThrow()
    }
  })
})
