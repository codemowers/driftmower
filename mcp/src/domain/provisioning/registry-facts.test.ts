import { describe, expect, it } from 'vitest'
import { findRegistries, isZotImage, kubeContextFor, skaffoldEnvFor } from './registry-facts.js'

const zot = (name: string, image: string, labels: Record<string, string>) => ({
  metadata: { name },
  spec: { template: { metadata: { labels }, spec: { containers: [{ image }] } } }
})
const service = (name: string, selector?: Record<string, string>) => ({
  metadata: { name },
  spec: { selector }
})
const ingress = (name: string, host: string, backend: string, tls = true) => ({
  metadata: { name },
  spec: {
    tls: tls ? [{ hosts: [host] }] : [],
    rules: [{ host, http: { paths: [{ backend: { service: { name: backend } } }] } }]
  }
})

describe('isZotImage', () => {
  it('recognises Zot builds wherever they are mirrored', () => {
    expect(isZotImage('ghcr.io/project-zot/zot-linux-amd64:v2.1.2')).toBe(true)
    expect(isZotImage('ghcr.io/project-zot/zot-minimal:v2.1.2@sha256:abc')).toBe(true)
    expect(isZotImage('mirror.example/zot')).toBe(true)
    expect(isZotImage('docker.io/library/registry:2')).toBe(false)
    expect(isZotImage('ghcr.io/example/zotero:1')).toBe(false)
  })
})

describe('findRegistries', () => {
  it('follows Deployment → selecting Service → Ingress to the published host', () => {
    expect(
      findRegistries(
        [
          zot('registry', 'ghcr.io/project-zot/zot-linux-amd64:v2', {
            'app.kubernetes.io/name': 'registry',
            tier: 'x'
          })
        ],
        [service('other', { app: 'web' }), service('registry', { 'app.kubernetes.io/name': 'registry' })],
        [
          ingress('web', 'web.team.example', 'other'),
          ingress('registry', 'registry.team.example', 'registry')
        ]
      )
    ).toEqual([
      {
        kind: 'zot',
        host: 'registry.team.example',
        tls: true,
        deployment: 'registry',
        service: 'registry',
        ingress: 'registry'
      }
    ])
  })

  it('ignores non-Zot workloads, selector-less Services and unpublished registries', () => {
    const labels = { app: 'registry' }

    expect(
      findRegistries(
        [zot('distribution', 'registry:2', labels)],
        [service('registry', labels)],
        [ingress('registry', 'registry.team.example', 'registry')]
      )
    ).toEqual([])
    expect(
      findRegistries(
        [zot('registry', 'zot', labels)],
        [service('registry')],
        [ingress('r', 'r.example', 'registry')]
      )
    ).toEqual([])
    expect(findRegistries([zot('registry', 'zot', labels)], [service('registry', labels)], [])).toEqual([])
  })

  it('reports a host the Ingress does not terminate TLS for', () => {
    const labels = { app: 'registry' }

    expect(
      findRegistries(
        [zot('registry', 'zot', labels)],
        [service('registry', labels)],
        [ingress('registry', 'registry.lan', 'registry', false)]
      )[0]?.tls
    ).toBe(false)
  })
})

describe('skaffoldEnvFor', () => {
  it('names the namespace-qualified context, the registry and the namespace', () => {
    expect(
      skaffoldEnvFor({
        context: kubeContextFor('ee-lte-1.codemowers.io', 'quake3'),
        registryHost: 'registry.quake3.ee-lte-1.codemowers.io',
        namespace: 'quake3'
      })
    ).toBe(
      [
        'SKAFFOLD_KUBE_CONTEXT=ee-lte-1.codemowers.io/quake3',
        'SKAFFOLD_DEFAULT_REPO=registry.quake3.ee-lte-1.codemowers.io',
        'SKAFFOLD_NAMESPACE=quake3',
        'SKAFFOLD_CLEANUP=false'
      ].join('\n')
    )
  })

  it('leaves a placeholder when the cluster identity is unknown', () => {
    expect(kubeContextFor(null, 'team-a')).toBe('<cluster>/team-a')
  })
})
