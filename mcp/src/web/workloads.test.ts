import { expect, it } from 'vitest'
import { workloadYaml } from './workloads.js'

it('nests workload roots by qualified kind and object name', () => {
  const rendered = workloadYaml(
    [
      {
        namespace: 'production',
        kind: 'Cluster',
        name: 'database',
        apiVersion: 'postgresql.cnpg.io/v1',
        pods: ['database-0']
      }
    ],
    ''
  )

  expect(rendered.owners[0].text).toContain('"Cluster.postgresql.cnpg.io":\n  "database":\n')
  expect(rendered.owners[0].label).toContain('production')
  expect(rendered.owners[0].text).not.toContain('namespace:')
  expect(rendered.owners[0].text).not.toContain('apiVersion:')
  expect(rendered.owners[0].text).toContain('    pods:\n      - "database-0"')
  expect(
    workloadYaml(
      [{ namespace: 'production', kind: 'Cluster', name: 'database', apiVersion: 'postgresql.cnpg.io/v1' }],
      'Cluster.postgresql.cnpg.io'
    ).shown
  ).toBe(1)
})

it('groups generating owners only inside namespace orphans without duplicating their resources', () => {
  const rendered = workloadYaml(
    [
      {
        namespace: 'default',
        kind: 'Namespace',
        name: 'orphaned-workloads',
        secrets: ['mat-secrets', 'unowned'],
        orphaned: {
          'StringSecret.secretgenerator.mittwald.de': {
            'mat-secrets': { ownerReferenceOnly: true, secrets: ['mat-secrets'] }
          }
        }
      }
    ],
    ''
  )

  expect(rendered.owners[0].text).toBe(`orphaned:
  "StringSecret.secretgenerator.mittwald.de":
    "mat-secrets":
      ownerReferenceOnly: true
      secrets:
        - "mat-secrets"
  secrets:
    - "unowned"
`)
})
