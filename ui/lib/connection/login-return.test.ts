import assert from "node:assert/strict"
import { test } from "node:test"
import { loginDestination, loginCallbackDestination } from "./login-return.ts"

const origin="http://localhost:17843"
const summary="/executive-summary"

test("sign-in restores the full linked page from the validated OIDC transaction",()=>{
  for(const path of ["/namespaces/team","/topmost-owners/a/pod-uid?tab=metadata#details","/container-images/docker.io/library/python/-/sha256%3A123?filters=showscanpods"]){
    const returnTo=loginDestination(path,origin)
    assert.equal(returnTo,path)
    assert.equal(loginCallbackDestination({returnTo},origin),path)
  }
})

test("separate OIDC transactions retain their own return destinations",()=>{
  const first={returnTo:loginDestination("/namespaces/first",origin)}
  const second={returnTo:loginDestination("/namespaces/second?filters=showscanpods",origin)}
  assert.equal(loginCallbackDestination(second,origin),"/namespaces/second?filters=showscanpods")
  assert.equal(loginCallbackDestination(first,origin),"/namespaces/first")
})

test("entry pages and callbacks without saved destinations use Executive Summary",()=>{
  for(const path of ["/","/settings","/settings?connect=context","/callback?code=private&state=private","/callback/",undefined,null,123]){
    assert.equal(loginDestination(path,origin),summary)
  }
  for(const state of [undefined,null,{},"/namespaces/team",{returnTo:123}])assert.equal(loginCallbackDestination(state,origin),summary)
})

test("return destinations cannot navigate to another origin",()=>{
  for(const path of ["https://evil.example/","//evil.example/path","/\\evil.example/path","/\n/evil.example","javascript:alert(1)","data:text/html,bad"]){
    assert.equal(loginCallbackDestination({returnTo:path},origin),summary)
  }
})
