import assert from "node:assert/strict"
import test from "node:test"
import {fetchWithContext,mcpOperation,requestError,requestTarget} from "./request.ts"

test("network errors identify the operation, method and sanitized endpoint", async t => {
 t.mock.method(globalThis,"fetch",async()=>{throw new TypeError("Failed to fetch")})
 await assert.rejects(fetchWithContext("Load MCP authentication configuration","https://user:secret@mcp.example/api/client-config?token=private#fragment"),error=>{
  assert.ok(error instanceof Error)
  assert.match(error.message,/Load MCP authentication configuration failed \(GET https:\/\/mcp.example\/api\/client-config\): Failed to fetch/)
  assert.ok(!/secret|private|fragment/.test(error.message))
  return true
 })
})

test("navigation cancellation stays an AbortError",async t=>{
 const error=new DOMException("Aborted","AbortError")
 t.mock.method(globalThis,"fetch",async()=>{throw error})
 await assert.rejects(fetchWithContext("Load metrics","/api/metrics"),value=>value===error)
})

test("MCP descriptions include tool names without request arguments",()=>{
 const init={method:"POST",body:JSON.stringify({method:"tools/call",params:{name:"get_inventory_status",arguments:{token:"private"}}})}
 assert.equal(mcpOperation(init),"MCP tool get_inventory_status")
 assert.equal(mcpOperation({method:"GET"}),"MCP update stream")
 assert.equal(mcpOperation({body:JSON.stringify({method:"initialize"})}),"MCP initialize")
 assert.equal(requestTarget("/api/metrics?query=private"),"/api/metrics")
})

test("nested request errors preserve the precise original operation",()=>{
 const error=requestError(new TypeError("Failed to fetch"),"MCP tool get_workloads","https://mcp.example/mcp","POST")
 assert.equal(requestError(error,"Connect to MCP","https://mcp.example/mcp"),error)
})

test("URLs inside error reasons cannot expose credentials or callback codes",()=>{
 const error=requestError(new Error("Unable to load https://user:secret@issuer.example/token?code=private"),"OIDC sign-in","https://issuer.example")
 assert.ok(!/secret|private|code=/.test(error.message))
 assert.match(error.message,/issuer\.example\/token/)
 assert.equal(requestTarget("http://[invalid"),"invalid endpoint")
})
