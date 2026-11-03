import assert from "node:assert/strict"
import { test } from "node:test"

import { fetchCapabilitiesFromMcp } from "./mcp-capabilities.ts"

function fakeFetch(status: number, body: string | (() => never)) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const impl = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string> })
    if (typeof body === "function") body()
    return new Response(body as string, { status })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const base = { baseUrl: "http://driftmower-mcp:3000/", accessToken: "mcp-token" }

test("forwards the namespaces, the offering and the caller's MCP token", async () => {
  const { impl, calls } = fakeFetch(200, JSON.stringify({ inCluster: true, withheld: [] }))
  const result = await fetchCapabilitiesFromMcp({ ...base, namespaces: ["a", "b"], offering: "postgres", fetchImplementation: impl })

  assert.equal(result.ok, true)
  assert.equal(calls[0].url, "http://driftmower-mcp:3000/api/provisioning/capabilities?ns=a%2Cb&offering=postgres")
  assert.equal(calls[0].headers.authorization, "Bearer mcp-token")
})

test("omits empty parameters", async () => {
  const { impl, calls } = fakeFetch(200, "{}")
  await fetchCapabilitiesFromMcp({ ...base, namespaces: [], offering: null, fetchImplementation: impl })
  assert.equal(calls[0].url, "http://driftmower-mcp:3000/api/provisioning/capabilities")
})

test("a refused token becomes the page's sign-in-again case", async () => {
  const { impl } = fakeFetch(401, JSON.stringify({ error: "invalid_token", error_description: 'unexpected "aud" claim value' }))
  const result = await fetchCapabilitiesFromMcp({ ...base, namespaces: [], offering: null, fetchImplementation: impl })

  assert.deepEqual(result, { ok: false, status: 401, body: { error: "invalid_token", detail: 'unexpected "aud" claim value' } })
})

test("a bad request is relayed, and every other failure is a 4xx the edge will not rewrite", async () => {
  const tooMany = await fetchCapabilitiesFromMcp({
    ...base,
    namespaces: [],
    offering: null,
    fetchImplementation: fakeFetch(400, JSON.stringify({ error: "too_many_namespaces", error_description: "At most 20" })).impl,
  })
  assert.deepEqual(tooMany, { ok: false, status: 400, body: { error: "too_many_namespaces", detail: "At most 20" } })

  const upstream = await fetchCapabilitiesFromMcp({
    ...base,
    namespaces: [],
    offering: null,
    fetchImplementation: fakeFetch(502, JSON.stringify({ error: "kubernetes_unreachable", error_description: "ECONNREFUSED" })).impl,
  })
  assert.deepEqual(upstream, { ok: false, status: 424, body: { error: "kubernetes_unreachable", detail: "ECONNREFUSED" } })

  const html = await fetchCapabilitiesFromMcp({
    ...base,
    namespaces: [],
    offering: null,
    fetchImplementation: fakeFetch(502, "<html>bad gateway</html>").impl,
  })
  assert.equal(html.ok, false)
  assert.equal(!html.ok && html.body.error, "mcp_bad_response")
})

test("an unreachable server is named, with its address", async () => {
  const result = await fetchCapabilitiesFromMcp({
    ...base,
    namespaces: [],
    offering: null,
    fetchImplementation: fakeFetch(0, () => {
      throw new Error("getaddrinfo ENOTFOUND driftmower-mcp")
    }).impl,
  })

  assert.equal(result.ok, false)
  assert.equal(!result.ok && result.status, 424)
  assert.match(!result.ok ? result.body.detail : "", /http:\/\/driftmower-mcp:3000: getaddrinfo ENOTFOUND/)
})
