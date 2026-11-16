import assert from "node:assert/strict"
import test from "node:test"
import { classifyLicense } from "./license.ts"

test("OSI approval and copyleft stay independent; Boost and Business Source are distinct", () => {
  assert.equal(classifyLicense({spdxId:"MIT"}).tone, "green")
  const gpl = classifyLicense({spdxId:"GPL-3.0-only"})
  assert.equal(gpl.classification,"Copyleft")
  assert.equal(gpl.osi,true)
  assert.equal(gpl.tone,"yellow")
  assert.equal(classifyLicense({spdxId:"BUSL-1.1"}).classification,"BSL")
  assert.equal(classifyLicense({spdxId:"BUSL-1.1"}).osi,false)
  assert.equal(classifyLicense({spdxId:"BSL-1.0"}).tone,"green")
  assert.equal(classifyLicense({spdxId:"Apache-2.0"}).title,"Apache License 2.0")
  assert.equal(classifyLicense({name:"Apache-2.0"}).osi,true)
  assert.equal(classifyLicense({spdxId:"NOASSERTION",name:"Custom license"}).classification,"Unknown")
  assert.equal(classifyLicense().classification,"Unknown")
})
