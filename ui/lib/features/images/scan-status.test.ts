import {strict as assert} from "node:assert"
import {imageScanBadge,type ScanStatus} from "./scan-status.ts"

const row=(status:string):ScanStatus=>({status,done:status==="done"?1:0,total:1,pending:0,running:0,failed:0})
assert.equal(imageScanBadge(["a","a"],{a:row("done")}).total,1)
assert.equal(imageScanBadge(["a"],{}).status,"unavailable")
assert.equal(imageScanBadge(["a"],{a:row("pending")}).status,"pending")
assert.equal(imageScanBadge(["a"],{a:row("running")}).status,"running")
assert.equal(imageScanBadge(["a","b"],{a:row("done"),b:row("failed")}).status,"failed")
assert.equal(imageScanBadge(["a","b"],{a:row("done"),b:row("pending")}).status,"partial")
assert.equal(imageScanBadge(["a","b"],{a:row("done"),b:row("done")}).status,"done")
