import { describe, expect, it, vi } from 'vitest'
import { createNamespaceAccess } from './namespace-access.js'

const identity = { user: 'issuer#alice', groups: ['team-a', 'system:authenticated'] }
const subject = (kind: string, name: string) => ({ kind, name, apiGroup: 'rbac.authorization.k8s.io' })

function binding(namespace: string, subjects: object[], roleName = 'admin', kind = 'ClusterRole') {
  return {
    metadata: { namespace },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind, name: roleName },
    subjects
  }
}

describe('accessible namespace discovery', () => {
  it('reviews cluster-wide list permission and lists all namespaces when allowed', async () => {
    const allowed = vi.fn().mockResolvedValue(true)
    const read = vi.fn().mockResolvedValue(
      JSON.stringify({
        items: [
          { metadata: { name: 'team-b', labels: { hidden: 'value' } } },
          { metadata: { name: 'team-a' } }
        ]
      })
    )

    expect(await createNamespaceAccess(read, allowed, 'admin').listAccessibleNamespaces(identity)).toEqual({
      namespaces: ['team-a', 'team-b']
    })
    expect(allowed).toHaveBeenCalledWith(identity, { group: '', resource: 'namespaces', verb: 'list' })
    expect(read).toHaveBeenCalledExactlyOnceWith('/api/v1/namespaces?limit=500')
  })

  it('matches exact user/group subjects and exact role names, returning only namespace names', async () => {
    const allowed = vi.fn().mockResolvedValue(false)
    const read = vi.fn().mockResolvedValue(
      JSON.stringify({
        items: [
          binding('user-owned', [subject('User', identity.user)]),
          binding('group-owned', [subject('Group', 'team-a')]),
          binding('group-owned', [subject('User', identity.user)]),
          binding('local-role', [subject('User', identity.user)], 'admin', 'Role'),
          binding('other-user', [subject('User', 'issuer#bob')]),
          binding('other-group', [subject('Group', 'team-b')]),
          binding('wrong-role', [subject('User', identity.user)], 'cluster-admin'),
          binding('substring', [subject('User', 'alice')]),
          binding('wrong-kind', [subject('ServiceAccount', identity.user)]),
          binding('wrong-subject-group', [{ kind: 'User', name: identity.user, apiGroup: 'other' }]),
          {
            ...binding('wrong-role-group', [subject('User', identity.user)]),
            roleRef: { kind: 'ClusterRole', name: 'admin', apiGroup: 'other' }
          },
          binding('no-subjects', [])
        ]
      })
    )

    expect(await createNamespaceAccess(read, allowed, 'admin').listAccessibleNamespaces(identity)).toEqual({
      namespaces: ['group-owned', 'local-role', 'user-owned']
    })
    expect(read).toHaveBeenCalledExactlyOnceWith('/apis/rbac.authorization.k8s.io/v1/rolebindings?limit=500')
  })

  it('uses the configured role and paginates the fallback', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          metadata: { continue: 'next/+' },
          items: [binding('wrong', [subject('User', identity.user)])]
        })
      )
      .mockResolvedValueOnce(
        JSON.stringify({ items: [binding('owned', [subject('Group', 'team-a')], 'developer')] })
      )

    expect(
      await createNamespaceAccess(
        read,
        vi.fn().mockResolvedValue(false),
        'developer'
      ).listAccessibleNamespaces(identity)
    ).toEqual({
      namespaces: ['owned']
    })
    expect(read.mock.calls[1][0]).toContain('continue=next%2F%2B')
  })

  it('returns an empty fallback result without broadening access', async () => {
    const read = vi.fn().mockResolvedValue(JSON.stringify({ items: [] }))

    expect(
      await createNamespaceAccess(read, vi.fn().mockResolvedValue(false), 'admin').listAccessibleNamespaces(
        identity
      )
    ).toEqual({
      namespaces: []
    })
  })

  it('does not read resources when the access review fails', async () => {
    const read = vi.fn()
    const allowed = vi.fn().mockRejectedValue(new Error('inconclusive'))

    await expect(
      createNamespaceAccess(read, allowed, 'admin').listAccessibleNamespaces(identity)
    ).rejects.toThrow('inconclusive')
    expect(read).not.toHaveBeenCalled()
  })

  it.each([true, false])('propagates resource-list failures (namespace list allowed: %s)', async allowed => {
    const read = vi.fn().mockRejectedValue(new Error('HTTP 403'))

    await expect(
      createNamespaceAccess(read, vi.fn().mockResolvedValue(allowed), 'admin').listAccessibleNamespaces(
        identity
      )
    ).rejects.toThrow('403')
    expect(read).toHaveBeenCalledOnce()
  })

  it('keeps concurrent callers isolated', async () => {
    const read = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ items: [binding('alice-only', [subject('User', identity.user)])] }))
    const service = createNamespaceAccess(read, vi.fn().mockResolvedValue(false), 'admin')
    const results = await Promise.all([
      service.listAccessibleNamespaces(identity),
      service.listAccessibleNamespaces({ user: 'bob', groups: [] })
    ])

    expect(results.map(result => result.namespaces)).toEqual([['alice-only'], []])
  })
})
