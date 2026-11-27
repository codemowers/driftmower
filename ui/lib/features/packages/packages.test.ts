import test from "node:test"
import assert from "node:assert/strict"
import {filterPackages,packageIdentity,packageName,packagePath,type PackageSummary} from "./types.ts"

test("package identities preserve scopes and distro namespaces",()=>{
 assert.equal(packageIdentity("pkg:npm/%40types/express@5.0.0"),"pkg:npm/%40types/express")
 assert.equal(packageIdentity("pkg:deb/debian/openssl@3.0?arch=amd64"),"pkg:deb/debian/openssl")
 assert.equal(packageName("%40types/express"),"@types/express")
 const id="pkg:npm/%40types/express";assert.equal(decodeURIComponent(packagePath(id).slice("/packages/".length)),id)
})
test("package tag filters are OR within tags and AND with text",()=>{
 const row=(id:string,tags:string[]):PackageSummary=>({id,name:id,ecosystem:"npm",versions:1,images:1,vulnerabilities:0,tags})
 const rows=[row("pkg:npm/react",["frontend","framework"]),row("pkg:npm/express",["backend","framework"]),row("pkg:npm/other",[])]
 assert.equal(filterPackages(rows,"",["frontend","backend"]).length,2)
 assert.deepEqual(filterPackages(rows,"react",["frontend","backend"]),[rows[0]])
 assert.equal(filterPackages(rows,"react",["backend"]).length,0)
 assert.equal(filterPackages(rows,"",[]).length,3)
})
