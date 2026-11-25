import assert from "node:assert/strict"
import test from "node:test"
import { beginDownload, downloadProgress, responseSize } from "./downloads.ts"
import { fetchWithContext } from "./request.ts"

test("overlapping downloads aggregate totals only when every response size is known", () => {
  const first = beginDownload(), second = beginDownload()
  first.size(12); first.add(5)
  assert.equal(downloadProgress.getState().totalBytes, null)
  second.size(8)
  assert.equal(downloadProgress.getState().totalBytes, 20)
  first.finish(); second.add(8); second.finish()
  assert.deepEqual(downloadProgress.getState(), { receivedBytes: 13, totalBytes: 13, activeRequests: 0 })
  second.finish()
  assert.equal(downloadProgress.getState().activeRequests, 0)
})

test("count streamed UTF-8 response bytes before completion without changing the body or metadata", async t => {
  let source!: ReadableStreamDefaultController<Uint8Array>
  const text = '{"name":"é"}', bytes = new TextEncoder().encode(text)
  const original = new Response(new ReadableStream<Uint8Array>({start(controller) {source = controller}}), { headers: {"Content-Length": String(bytes.length), "Content-Type": "application/json"} })
  Object.defineProperty(original, "url", { value: "https://mcp.example/mcp" })
  t.mock.method(globalThis, "fetch", async () => original)
  const response = await fetchWithContext("Load test", "/api/data")
  assert.equal(response.url, original.url)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get("Content-Type"), "application/json")
  const result = response.json()
  source.enqueue(bytes.slice(0, 8))
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(downloadProgress.getState().receivedBytes, 8)
  assert.equal(downloadProgress.getState().activeRequests, 1)
  source.enqueue(bytes.slice(8)); source.close()
  assert.deepEqual(await result, { name: "é" })
  assert.equal(downloadProgress.getState().receivedBytes, bytes.length)
  assert.equal(downloadProgress.getState().activeRequests, 0)
})

test("cancellation and stream failures clear in-flight progress", async t => {
  let cancelled = false
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({cancel() {cancelled = true}})))
  const response = await fetchWithContext("Load test", "/api/data")
  await response.body!.cancel("navigation")
  assert.equal(cancelled, true)
  assert.equal(downloadProgress.getState().activeRequests, 0)
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({pull(controller) {controller.error(new Error("stream failed"))}})))
  const failed = await fetchWithContext("Load test", "/api/data")
  await assert.rejects(failed.text(), /stream failed/)
  assert.equal(downloadProgress.getState().activeRequests, 0)
})

test("compressed and invalid lengths never produce false download totals", () => {
  assert.equal(responseSize(new Response("test", {headers:{"Content-Length":"2", "Content-Encoding":"gzip"}})), null)
  assert.equal(responseSize(new Response("test", {headers:{"Content-Length":"bad"}})), null)
  const transfer = beginDownload()
  transfer.size(2); transfer.add(4)
  assert.equal(downloadProgress.getState().totalBytes, null)
  transfer.finish()
  assert.equal(downloadProgress.getState().receivedBytes, 4)
})

test("empty responses and persistent MCP update streams do not leave a download running", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, {status:204}))
  await fetchWithContext("Save profile", "/api/profile")
  assert.equal(downloadProgress.getState().activeRequests, 0)
  const source = new Response(new ReadableStream())
  t.mock.method(globalThis, "fetch", async () => source)
  assert.equal(await fetchWithContext("MCP update stream", "/mcp"), source)
  assert.equal(downloadProgress.getState().activeRequests, 0)
  await source.body!.cancel()
})


test("desktop control requests bypass byte tracking and preserve the original response", async t => {
  for (const path of ["/dashboard-config.json", "/api/desktop/browser-profile", "/api/desktop/connect", "/api/desktop/retry", "/api/kubernetes-sign-in"]) {
    const original = new Response("local response")
    t.mock.method(globalThis, "fetch", async () => original)
    const response = await fetchWithContext("Desktop control", path)
    assert.equal(response, original)
    assert.equal(downloadProgress.getState().activeRequests, 0)
    assert.equal(await response.text(), "local response")
  }
})

test("null-body statuses never inspect or wrap a body stream", async t => {
  for (const status of [204, 205, 304]) {
    const original = new Response(null, {status})
    Object.defineProperty(original, "body", {get() {throw new Error("must not access a null-status body")}})
    t.mock.method(globalThis, "fetch", async () => original)
    assert.equal(await fetchWithContext("Cluster request", "/mcp"), original)
    assert.equal(downloadProgress.getState().activeRequests, 0)
  }
})

test("port-forwarded MCP responses still count bytes", async t => {
  t.mock.method(globalThis, "fetch", async () => new Response("cluster response"))
  const response = await fetchWithContext("MCP tool get_inventory_status", "http://127.0.0.1:30081/mcp")
  assert.equal(downloadProgress.getState().activeRequests, 1)
  await response.text()
  assert.equal(downloadProgress.getState().receivedBytes, 16)
  assert.equal(downloadProgress.getState().activeRequests, 0)
})
