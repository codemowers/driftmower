import assert from "node:assert/strict"
import {test} from "node:test"
import {accessWarningReasons} from "./access-warnings.ts"

test("rules-review limitations are shown once without hiding other warnings",()=>{
 const reason="webhook authorizer does not support user rule resolution"
 assert.deepEqual(accessWarningReasons({examined:["agents","default"],incomplete:["","agents","default"],warnings:[`Cluster-wide review: ${reason}`,`agents: ${reason}`,`default: ${reason}`,"Groups claim: may differ"]}),[reason,"Groups claim: may differ"])
})
