import {strict as assert} from "node:assert"
import {setImmediate} from "node:timers/promises"
import {historyRequest} from "./request.ts"

let running=0,peak=0
const releases:(()=>void)[]=[]
const tasks=Array.from({length:7},(_,i)=>historyRequest(async()=>{
 running++;peak=Math.max(peak,running)
 await new Promise<void>(resolve=>releases.push(resolve))
 running--;return i
}))
await setImmediate()
assert.equal(running,3)
for(let i=0;i<7;i++){releases.shift()!();await setImmediate()}
assert.deepEqual(await Promise.all(tasks),[0,1,2,3,4,5,6])
assert.equal(peak,3)

const held=Array.from({length:3},()=>historyRequest(()=>new Promise<void>(resolve=>releases.push(resolve))))
const controller=new AbortController()
let executed=false
const canceled=historyRequest(async()=>{executed=true},controller.signal)
const rejection=assert.rejects(canceled,{name:"AbortError"})
controller.abort()
releases.shift()!()
await rejection
for(const release of releases.splice(0))release()
await Promise.all(held)
assert.equal(executed,false)
