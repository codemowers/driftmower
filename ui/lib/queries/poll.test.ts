import assert from "node:assert/strict"
import test from "node:test"
import { poll } from "./poll.ts"

const flush=async()=>{await Promise.resolve();await Promise.resolve()}
test("slow reads never overlap and poll delay starts after completion",async t=>{
 t.mock.timers.enable({apis:["setTimeout"]})
 let calls=0,resolve!:(value:number)=>void
 const values:number[]=[]
 const stop=poll<number>({load:()=>{calls++;return new Promise<number>(done=>{resolve=done})},receive:value=>values.push(value),fail:error=>assert.fail(String(error)),interval:30_000})
 t.mock.timers.tick(300_000);assert.equal(calls,1)
 resolve(7);await flush();assert.deepEqual(values,[7])
 t.mock.timers.tick(29_999);assert.equal(calls,1)
 t.mock.timers.tick(1);assert.equal(calls,2)
 stop()
})
test("navigation aborts the read and ignores even non-cooperative late responses",async t=>{
 t.mock.timers.enable({apis:["setTimeout"]})
 let resolve!:(value:number)=>void,signal!:AbortSignal,calls=0
 const values:number[]=[]
 const stop=poll<number>({load:s=>{signal=s;calls++;return new Promise<number>(done=>{resolve=done})},receive:v=>values.push(v),fail:error=>assert.fail(String(error)),interval:10})
 stop();assert.equal(signal.aborted,true)
 resolve(1);await flush();t.mock.timers.tick(1000)
 assert.deepEqual(values,[]);assert.equal(calls,1)
})
test("a failed poll retries and stopping cancels its scheduled retry",async t=>{
 t.mock.timers.enable({apis:["setTimeout"]})
 let calls=0;const errors:unknown[]=[],values:number[]=[]
 const stop=poll<number>({load:async()=>{if(++calls===1)throw new Error("offline");return calls},receive:v=>values.push(v),fail:e=>errors.push(e),interval:50})
 await flush();assert.equal(errors.length,1)
 t.mock.timers.tick(50);await flush();assert.deepEqual(values,[2])
 stop();t.mock.timers.tick(500);assert.equal(calls,2)
})
