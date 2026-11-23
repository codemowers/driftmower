import assert from "node:assert/strict"
import test from "node:test"
import { resizeStatus } from "./resize-status.ts"
import type { Claim } from "./types.ts"

const claim = {requestedStorage:"143052Mi",provisionedStorage:"100G",resizeStatus:"ControllerResizeInProgress",conditions:[{type:"Resizing",status:"True"},{type:"ControllerResizeError",status:"True",message:"failed to expand pvc: not enough space"}]} as Claim

test("resize failures take priority over the in-progress condition and retain the CSI message", () => {
  assert.deepEqual(resizeStatus(claim),{warning:true,label:"Resize failed",message:"failed to expand pvc: not enough space"})
  assert.equal(resizeStatus({...claim,conditions:[{type:"ControllerResizeError",status:"False"}]})?.warning,false)
})
test("node/filesystem resize waiting states and allocated resize failures are distinguished", () => {
  assert.equal(resizeStatus({...claim,conditions:[{type:"FileSystemResizePending",status:"True"}]})?.label,"Filesystem resize pending")
  assert.equal(resizeStatus({...claim,conditions:[],resizeStatus:"ControllerResizeInfeasible"})?.warning,true)
  assert.equal(resizeStatus({...claim,requestedStorage:"100G",conditions:[],resizeStatus:undefined}),null)
  assert.equal(resizeStatus({...claim,requestedStorage:"8Gi",provisionedStorage:"8192Mi",conditions:[],resizeStatus:undefined}),null)
})
