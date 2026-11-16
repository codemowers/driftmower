import assert from "node:assert/strict"
import test from "node:test"
import {connectionTitle,contextTitle} from "./labels.ts"
import type {KubeconfigConnection} from "./contexts"

test("pending connections display their context name instead of opaque keys",()=>{
 const context:KubeconfigConnection={key:"52c9959ab66",name:"admin@cluster.example",status:"connecting"}
 assert.equal(connectionTitle(context,context.key),"admin@cluster.example")
 assert.equal(connectionTitle({...context,url:"https://mcp.driftmower.cluster.example/mcp"},context.key),"cluster.example")
 assert.equal(connectionTitle({...context,portForward:true,url:"http://127.0.0.1:43123/mcp"},context.key),"admin@cluster.example")
})

test("unknown internal identifiers never become user-visible labels",()=>{
 assert.equal(connectionTitle(undefined,"52c9959ab66"),"Select a cluster")
 assert.equal(contextTitle("https://mcp.driftmower.cluster.example/mcp"),"cluster.example")
})
