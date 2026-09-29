import { describe, expect, it, vi } from 'vitest'
import { checkAuthorizer } from './identity-diagnostics.js'

describe('checkAuthorizer', () => {
  it('probes as a synthetic prefixed user with only the implicit group', async () => {
    const allowed = vi.fn().mockResolvedValue(true)

    expect(await checkAuthorizer(allowed, 'issuer#')).toEqual({ sarUsable: true, warning: null })
    expect(allowed).toHaveBeenCalledWith(
      { user: 'issuer#driftmower-mcp-selfcheck', groups: ['system:authenticated'] },
      { group: 'authorization.k8s.io', resource: 'selfsubjectaccessreviews', verb: 'create' }
    )
  })

  it('warns when basic-user is missing and when reviews cannot be created at all', async () => {
    expect(await checkAuthorizer(vi.fn().mockResolvedValue(false), '')).toMatchObject({
      sarUsable: true,
      warning: expect.stringContaining('system:basic-user')
    })
    expect(await checkAuthorizer(vi.fn().mockRejectedValue(new Error('HTTP 403')), '')).toMatchObject({
      sarUsable: false,
      warning: expect.stringContaining('HTTP 403')
    })
  })
})
