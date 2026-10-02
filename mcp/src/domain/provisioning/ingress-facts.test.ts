import { describe, expect, it } from 'vitest'

import {
  hostIsAllowed,
  hostRejectionReason,
  hostRuleFor,
  parseCustomDomains,
  suffixFromParams,
  tlsAdvice
} from './ingress-facts.js'

// A real sandbox id: the hash prefix is assigned at creation, so a user cannot
// guess it and therefore cannot guess their own hostname.
const RULE = hostRuleFor('ee-lte-1.codemowers.io', 'a1b2c3-demo', 'sandbox-ingress-guard')

it('the rule spells out both hostnames the guard accepts', () => {
  expect(RULE.exactHost).toBe('a1b2c3-demo.ee-lte-1.codemowers.io')
  expect(RULE.labelledPattern).toBe('a1b2c3-demo-<label>.ee-lte-1.codemowers.io')
})

it('the exact host and a single-label host are allowed', () => {
  expect(hostIsAllowed('a1b2c3-demo.ee-lte-1.codemowers.io', RULE)).toBe(true)
  expect(hostIsAllowed('a1b2c3-demo-api.ee-lte-1.codemowers.io', RULE)).toBe(true)
  // The <id>-prom convention the sandbox Prometheus UI uses.
  expect(hostIsAllowed('a1b2c3-demo-prom.ee-lte-1.codemowers.io', RULE)).toBe(true)
})

it('a host not anchored on the sandbox id is rejected', () => {
  expect(hostIsAllowed('myapp.ee-lte-1.codemowers.io', RULE)).toBe(false)
  // Another tenant's namespace — the whole reason the guard exists.
  expect(hostIsAllowed('z9y8x7-other.ee-lte-1.codemowers.io', RULE)).toBe(false)
  // The platform's own hostname.
  expect(hostIsAllowed('driftmower-ui.ee-lte-1.codemowers.io', RULE)).toBe(false)
})

it('wildcards are rejected, and the reason says why', () => {
  expect(hostIsAllowed('*.ee-lte-1.codemowers.io', RULE)).toBe(false)
  expect(hostRejectionReason('*.ee-lte-1.codemowers.io', RULE) ?? '').toMatch(/shared/)
})

it("an extra dot in the label is rejected, matching the guard's CEL", () => {
  // The guard checks the middle segment contains no ".", which is what stops
  // `<id>-foo.bar.<suffix>` smuggling in a new subdomain level.
  expect(hostIsAllowed('a1b2c3-demo-foo.bar.ee-lte-1.codemowers.io', RULE)).toBe(false)
})

it('the id as a bare prefix with nothing after the dash is rejected', () => {
  expect(hostIsAllowed('a1b2c3-demo-.ee-lte-1.codemowers.io', RULE)).toBe(false)
})

it('a different suffix is rejected even with the right id', () => {
  expect(hostIsAllowed('a1b2c3-demo.ee-west-1.codemowers.io', RULE)).toBe(false)
})

it('an allowed host has no rejection reason', () => {
  expect(hostRejectionReason('a1b2c3-demo-api.ee-lte-1.codemowers.io', RULE)).toBe(null)
})

it("the suffix comes from the guard's own ConfigMap key", () => {
  expect(suffixFromParams({ ingressDomainSuffix: 'ee-lte-1.codemowers.io' })).toBe('ee-lte-1.codemowers.io')
  // A leading dot is tolerated, since the guard prepends one itself.
  expect(suffixFromParams({ ingressDomainSuffix: '.ee-lte-1.codemowers.io' })).toBe('ee-lte-1.codemowers.io')
  expect(suffixFromParams({})).toBe(null)
  expect(suffixFromParams(undefined)).toBe(null)
  expect(suffixFromParams({ ingressDomainSuffix: '  ' })).toBe(null)
})

it('TLS advice names the issuer when there is one, and says so when there is not', () => {
  expect(tlsAdvice([{ name: 'letsencrypt', ready: true, acme: { http01: true, dns01: false } }])).toMatch(/letsencrypt ClusterIssuer/)
  expect(tlsAdvice([])).toMatch(/not automatic/)
})

// bravo's real list: the internal CA sorts first, and used to be what we advised
// for public hosts. Only an ACME issuer can certify a public name.
it('TLS advice picks the ACME issuer for public hostnames, never an internal CA', () => {
  const advice = tlsAdvice([
    { name: 'cluster-tls-issuer', ready: true, acme: null },
    { name: 'letsencrypt', ready: true, acme: { http01: true, dns01: false } },
    { name: 'selfsigned-issuer', ready: true, acme: null }
  ])

  expect(advice).toMatch(/one certificate each from the letsencrypt ClusterIssuer over ACME HTTP-01/)
  expect(advice).toMatch(/cert-manager\.io\/cluster-issuer: letsencrypt/)
  expect(advice).toMatch(/no ClusterIssuer here offers/)
  expect(advice).toMatch(/ALIAS\/ANAME or CNAME flattening/)
  expect(advice).not.toMatch(/cluster-tls-issuer/)
})

it('TLS advice mentions wildcards only where a DNS-01 issuer exists, and skips issuers that are not ready', () => {
  expect(tlsAdvice([
    { name: 'letsencrypt', ready: true, acme: { http01: true, dns01: false } },
    { name: 'letsencrypt-dns', ready: true, acme: { http01: false, dns01: true } }
  ])).toMatch(/which the letsencrypt-dns ClusterIssuer offers/)
  expect(tlsAdvice([{ name: 'letsencrypt', ready: false, acme: { http01: true, dns01: false } }])).toMatch(/not automatic/)
  expect(tlsAdvice([{ name: 'internal', ready: true, acme: null }])).toMatch(/not ACME issuers/)
})

describe('namespace-anchored hosts and custom domains', () => {
  const rule = hostRuleFor('aws-us-west-2-bravo.codemowers.io', 'a1b2c3-demo', 'sandbox-ingress-guard', {
    namespace: 'sb-a1b2c3-demo',
    anchorsOnNamespace: true,
    customDomains: ['acme.com']
  })

  it('spells out the namespace space', () => {
    expect(rule.exactHost).toBe('sb-a1b2c3-demo.aws-us-west-2-bravo.codemowers.io')
    expect(rule.labelledPattern).toBe('<label>.sb-a1b2c3-demo.aws-us-west-2-bravo.codemowers.io')
  })

  it('mirrors the guard: namespace space, legacy prefix, verified domains', () => {
    for (const host of [
      'sb-a1b2c3-demo.aws-us-west-2-bravo.codemowers.io',
      'gitea.sb-a1b2c3-demo.aws-us-west-2-bravo.codemowers.io',
      'a.b.sb-a1b2c3-demo.aws-us-west-2-bravo.codemowers.io',
      'a1b2c3-demo-api.aws-us-west-2-bravo.codemowers.io',
      'acme.com',
      'www.acme.com'
    ]) expect(hostIsAllowed(host, rule), host).toBe(true)

    for (const host of [
      'evil.sb-z9y8x7-other.aws-us-west-2-bravo.codemowers.io',
      'xsb-a1b2c3-demo.aws-us-west-2-bravo.codemowers.io',
      'notacme.com',
      'victim.example.com',
      '*.acme.com'
    ]) expect(hostIsAllowed(host, rule), host).toBe(false)
  })

  it('names the custom domains when rejecting', () => {
    expect(hostRejectionReason('victim.example.com', rule)).toMatch(/under acme\.com: anchored on your namespace/)
  })

  it('reads the verified domains annotation as written by the platform', () => {
    expect(parseCustomDomains(' Acme.com, ,b.org ')).toEqual(['acme.com', 'b.org'])
    expect(parseCustomDomains(undefined)).toEqual([])
  })
})

// Parity with the apiserver, not just with my reading of the CEL. Each case
// below was submitted to a real sandbox-ingress-guard as a non-exempt sandbox
// owner (kubectl create --dry-run=server, sandbox abc123-demo, suffix
// veebkolm.eu) and the verdict recorded. If hostIsAllowed ever diverges, the
// page starts promising hostnames admission will reject.
it('hostIsAllowed matches what the guard actually decided', () => {
  const rule = hostRuleFor('veebkolm.eu', 'abc123-demo', 'sandbox-ingress-guard')

  const observed: [string, boolean][] = [
    ['abc123-demo.veebkolm.eu', true],
    ['abc123-demo-api.veebkolm.eu', true],
    ['myapp.veebkolm.eu', false],
    ['*.veebkolm.eu', false],
    ['abc123-demo-a.b.veebkolm.eu', false],
    // Another tenant's sandbox — the reason the guard exists.
    ['536389-mint.veebkolm.eu', false],
    ['abc123-demo.example.com', false]
  ]

  for (const [host, allowed] of observed) {
    expect(hostIsAllowed(host, rule), `${host} should be ${allowed ? 'allowed' : 'denied'}`).toBe(allowed)
  }
})
