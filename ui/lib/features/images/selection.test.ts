import assert from "node:assert/strict"
import test from "node:test"
import { selectedImageUsages } from "./selection.ts"
import type { ImageUsage } from "../../cluster/reports"

test("workload artifact route loads only its requested digest, across replicas",()=>{
 const usage=(uid:string,digest:string)=>({workloadRootInfo:{uid},imageInfo:{digest,registry:"docker.io",repository:"library/python"}} as ImageUsage)
 const rows=[usage("app","sha256:one"),usage("app","sha256:one"),usage("app","sha256:two"),usage("another","sha256:one")]
 assert.deepEqual(selectedImageUsages("/topmost-owners/app/images/sha256%3Aone",rows),rows.slice(0,2))
 assert.deepEqual(selectedImageUsages("/topmost-owners/app",rows),[])
 assert.equal(selectedImageUsages("/vulnerabilities",rows),rows)
 assert.equal(selectedImageUsages("/vulnerabilities/CVE-2026-1234",rows),rows)
 assert.deepEqual(selectedImageUsages("/container-images/docker.io/library/python",rows),rows)
})
