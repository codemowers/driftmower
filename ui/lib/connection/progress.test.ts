import assert from "node:assert/strict"
import { beforeEach, test } from "node:test"
import { connectionProgress, restoreConnectionProgress, useConnectionProgress } from "./progress.ts"

beforeEach(t => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  } })
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 })
  connectionProgress(null)
})

test("a new connection supersedes pending selections and cancels the old timeout", t => {
  connectionProgress("first", true)
  sessionStorage.setItem("driftmower.pending-connect", "first-key")
  t.mock.timers.tick(60_000)
  connectionProgress("second", true)
  assert.equal(sessionStorage.getItem("driftmower.pending-connect"), null)
  t.mock.timers.tick(60_000)
  assert.equal(useConnectionProgress.getState().target, "second")
  assert.equal(useConnectionProgress.getState().initiating, true)
  t.mock.timers.tick(60_000)
  assert.equal(useConnectionProgress.getState().target, null)
  assert.match(useConnectionProgress.getState().error!, /timed out/)
})

test("finishing a connection clears its pending retry and timer", t => {
  connectionProgress("cluster")
  sessionStorage.setItem("driftmower.pending-connect", "cluster-key")
  connectionProgress(null)
  t.mock.timers.tick(120_000)
  assert.equal(sessionStorage.getItem("driftmower.pending-connect"), null)
  assert.equal(sessionStorage.getItem("driftmower.connecting"), null)
  assert.equal(useConnectionProgress.getState().error, null)
})

test("restoration preserves a pending retry and only the remaining timeout", t => {
  sessionStorage.setItem("driftmower.connecting", JSON.stringify({ target: "cluster", started: Date.now() }))
  sessionStorage.setItem("driftmower.pending-connect", "cluster-key")
  t.mock.timers.tick(90_000)
  restoreConnectionProgress()
  assert.equal(useConnectionProgress.getState().target, "cluster")
  assert.equal(useConnectionProgress.getState().initiating, false)
  assert.equal(sessionStorage.getItem("driftmower.pending-connect"), "cluster-key")
  t.mock.timers.tick(30_000)
  assert.equal(useConnectionProgress.getState().target, null)
  assert.equal(sessionStorage.getItem("driftmower.pending-connect"), null)
})

test("invalid, expired and future persisted progress cannot trap the UI in Connecting", () => {
  for (const raw of ["{", "null", "[]", '{"target":"cluster"}',
    JSON.stringify({ target: "", started: Date.now() }),
    JSON.stringify({ target: "cluster", started: Date.now() + 1 }),
    JSON.stringify({ target: "cluster", started: Date.now() - 120_000 }),
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
