import assert from "node:assert/strict"
import { afterEach, beforeEach, test, type TestContext } from "node:test"
import { connectionProgress, connectionStage, restoreConnectionProgress, useConnectionProgress } from "./progress.ts"

beforeEach(context => {
  const t = context as TestContext
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  } })
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 })
  connectionProgress(null)
})

afterEach(() => connectionProgress(null))

test("a new connection supersedes pending selections and cancels the old timeout", t => {
  connectionProgress("first", true)
  sessionStorage.setItem("driftmower.pending-connect", "first-key")
  t.mock.timers.tick(5_000)
  connectionProgress("second", true)
  assert.equal(sessionStorage.getItem("driftmower.pending-connect"), null)
  t.mock.timers.tick(5_000)
  assert.equal(useConnectionProgress.getState().target, "second")
  assert.equal(useConnectionProgress.getState().initiating, true)
  t.mock.timers.tick(5_000)
  assert.equal(useConnectionProgress.getState().target, null)
  assert.match(useConnectionProgress.getState().error!, /timed out/)
})

test("finishing a connection clears its pending retry and timer", t => {
  connectionProgress("cluster")
  sessionStorage.setItem("driftmower.pending-connect", "cluster-key")
  connectionProgress(null)
  t.mock.timers.tick(10_000)
  assert.equal(sessionStorage.getItem("driftmower.pending-connect"), null)
  assert.equal(sessionStorage.getItem("driftmower.connecting"), null)
  assert.equal(useConnectionProgress.getState().error, null)
})

test("restoration preserves a pending retry and only the remaining timeout", t => {
  sessionStorage.setItem("driftmower.connecting", JSON.stringify({ target: "cluster", started: Date.now() }))
  sessionStorage.setItem("driftmower.pending-connect", "cluster-key")
  t.mock.timers.tick(7_000)
  restoreConnectionProgress()
  assert.equal(useConnectionProgress.getState().target, "cluster")
  assert.equal(useConnectionProgress.getState().initiating, false)
  assert.equal(sessionStorage.getItem("driftmower.pending-connect"), "cluster-key")
  t.mock.timers.tick(3_000)
  assert.equal(useConnectionProgress.getState().target, null)
  assert.equal(sessionStorage.getItem("driftmower.pending-connect"), null)
})

test("invalid, expired and future persisted progress cannot trap the UI in Connecting", () => {
  for (const raw of ["{", "null", "[]", '{"target":"cluster"}',
    JSON.stringify({ target: "", started: Date.now() }),
    JSON.stringify({ target: "cluster", started: Date.now() + 1 }),
    JSON.stringify({ target: "cluster", started: Date.now() - 10_000 }),
    '{"target":"cluster","started":1e400}',
  ]) {
    sessionStorage.setItem("driftmower.connecting", raw)
    sessionStorage.setItem("driftmower.pending-connect", "cluster-key")
    restoreConnectionProgress()
    assert.equal(useConnectionProgress.getState().target, null, raw)
    assert.equal(sessionStorage.getItem("driftmower.connecting"), null, raw)
    assert.equal(sessionStorage.getItem("driftmower.pending-connect"), null, raw)
  }
})

test("the friendly connection name survives redirects independently of its key",()=>{
 connectionProgress("52c9959ab66",true,"admin@cluster.example")
 assert.equal(useConnectionProgress.getState().label,"admin@cluster.example")
 useConnectionProgress.setState({label:null})
 restoreConnectionProgress()
 assert.equal(useConnectionProgress.getState().target,"52c9959ab66")
 assert.equal(useConnectionProgress.getState().label,"admin@cluster.example")
})


test("timeouts identify the context, stalled stage and safe endpoint after a redirect", t => {
 connectionProgress("opaque-internal-key",true,"cluster.example.test")
 connectionStage("initializing the MCP session","https://user:secret@mcp.example/mcp?token=private#fragment")
 assert.equal(useConnectionProgress.getState().started,1000)
 t.mock.timers.tick(7_000)
 restoreConnectionProgress()
 assert.equal(useConnectionProgress.getState().phase,"initializing the MCP session")
 t.mock.timers.tick(3_001)
 const error=useConnectionProgress.getState().error!
 assert.match(error,/Connection to cluster\.example\.test timed out after 10 seconds while initializing the MCP session \(https:\/\/mcp\.example\/mcp\)/)
 assert.match(error,/Open Settings and retry Connect for cluster\.example\.test/)
 assert.doesNotMatch(error,/opaque-internal-key|secret|private|fragment/)
})
test("late connection-stage updates cannot overwrite a new selection",()=>{
 connectionProgress("first",true,"First cluster")
 const previous=useConnectionProgress.getState().operation
 connectionProgress("second",true,"Second cluster")
 connectionStage("waiting for Kubernetes discovery","https://api.second.example")
 connectionStage("old request","https://api.first.example",previous)
 assert.equal(useConnectionProgress.getState().phase,"waiting for Kubernetes discovery")
 assert.equal(useConnectionProgress.getState().endpoint,"https://api.second.example/")
})
