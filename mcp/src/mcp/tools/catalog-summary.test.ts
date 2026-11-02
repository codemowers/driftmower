import { describe, expect, it } from 'vitest'
import { csv, policyCatalogCsv, capabilityCatalogCsv } from './catalog-summary.js'
import { describeCrdDefinition } from '../../clients/crd-details.js'

describe('compact catalog responses', () => {
  it('escapes CSV delimiters, quotes and newlines', () => {
    expect(csv(['name', 'description'], [['test', 'a, "quote"\nand newline']])).toBe(
      'name,description\ntest,"a, ""quote""\nand newline"\n'
    )
  })

  it('omits all policy code while retaining target restrictions and binding availability', () => {
    const output = policyCatalogCsv({
      unavailableKinds: [],
      policies: [
        {
          name: 'example',
          description: 'Example policy',
          kind: 'MutatingAdmissionPolicy',
          apiVersion: 'v1',
          annotations: {},
          spec: {
            matchConstraints: {
              resourceRules: [{ apiGroups: [''], resources: ['pods'] }],
              namespaceSelector: { matchLabels: { environment: 'test' } }
            },
            matchConditions: [{ name: 'condition', expression: 'PRIVATE_CODE' }],
            variables: [{ name: 'value', expression: 'PRIVATE_CODE' }],
            mutations: [{ patchType: 'JSONPatch', jsonPatch: { expression: 'PRIVATE_CODE' } }],
            unknownFutureField: 'PRIVATE_CODE'
          },
          bindings: null
        }
      ]
    })

    expect(output).toContain('pods')
    expect(output).toContain('environment')
    expect(output).not.toContain('PRIVATE_CODE')
    expect(output).not.toContain('mutations')
  })

  it('lists CRDs once without schema or status-derived fields', () => {
    const output = capabilityCatalogCsv({
      customResources: [
        {
          name: 'widgets.example.com',
          description: 'Widgets',
          kind: 'Widget',
          group: 'example.com',
          resource: 'widgets',
          scope: 'Namespaced',
          versions: [{ name: 'v1', served: true, storage: true }],
          established: true,
          terminating: false
        }
      ],
      capabilities: [],
      ingressClasses: [],
      priorityClasses: [],
      clusterIssuers: [{ name: 'internal', description: 'Internal TLS', ready: true, acme: null }],
      degraded: [],
      relatedTools: [],
      note: ''
    })

    expect(output).toContain('widgets.example.com,Widgets')
    expect(output).not.toMatch(/ready|established|terminating|storage|served/)
  })

  it('CRD details omit status schemas, controller metadata and CEL', () => {
    const output = describeCrdDefinition({
      metadata: { name: 'widgets.example.com', managedFields: ['PRIVATE'], annotations: {} },
      status: { conditions: ['PRIVATE'] },
      spec: {
        group: 'example.com',
        names: { kind: 'Widget', plural: 'widgets' },
        scope: 'Namespaced',
        versions: [
          {
            name: 'v1',
            served: true,
            schema: {
              openAPIV3Schema: {
                type: 'object',
                required: ['spec', 'status'],
                properties: {
                  spec: {
                    type: 'object',
                    properties: { replicas: { type: 'integer' } },
                    'x-kubernetes-validations': [{ rule: 'PRIVATE' }]
                  },
                  status: { description: 'PRIVATE' }
                }
              }
            }
          }
        ]
      }
    })

    expect(JSON.stringify(output)).not.toMatch(/status|PRIVATE|managedFields|x-kubernetes-validations/)
    expect(output.versions[0].schema).toMatchObject({
      properties: { spec: { properties: { replicas: { type: 'integer' } } } }
    })
  })
})
