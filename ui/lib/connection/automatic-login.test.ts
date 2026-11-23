import assert from "node:assert/strict"
import {test} from "node:test"
import {automaticLoginEndpoint,automaticLoginKey} from "./automatic-login.ts"

const endpoint="https://mcp.driftmower.cluster.example.test/mcp"
function store(){
 const values=new Map<string,string>()
 return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value)},removeItem:(key:string)=>{values.delete(key)}}
}

test("hosted entry and deep links initiate login once per endpoint/window",()=>{
 for(const path of ["/","/namespaces/team?filters=showscanpods","/executive-summary"]){
  const storage=store()
  assert.equal(automaticLoginEndpoint({mcpUrl:endpoint},path,storage),endpoint)
  assert.equal(automaticLoginEndpoint({mcpUrl:endpoint},path,storage),undefined)
  const other=endpoint+"-other"
  assert.equal(automaticLoginEndpoint({mcpUrl:other},path,storage),other)
  storage.removeItem(automaticLoginKey(endpoint))
  assert.equal(automaticLoginEndpoint({mcpUrl:endpoint},path,storage),endpoint)
 }
})

test("desktop selection, Settings and callbacks do not automatically redirect",()=>{
 for(const config of [{},{mcpUrl:endpoint,discoveryEnabled:true},{mcpUrl:endpoint,configUpdates:true},{mcpUrl:endpoint,chromeProfilesEnabled:true}]){
  assert.equal(automaticLoginEndpoint(config,"/",store()),undefined)
 }
 for(const path of ["/settings","/settings/","/callback","/callback/"]){
  const storage=store()
  assert.equal(automaticLoginEndpoint({mcpUrl:endpoint},path,storage),undefined)
  assert.equal(storage.getItem(automaticLoginKey(endpoint)),null)
 }
})
