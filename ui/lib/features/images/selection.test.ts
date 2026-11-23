import assert from "node:assert/strict"
import test from "node:test"
import { selectedImageMetadataUsages, selectedImageUsages } from "./selection.ts"
import type { ImageUsage } from "../../cluster/reports"

test("workload artifact route loads only its requested digest, across replicas",()=>{
 const usage=(uid:string,digest:string)=>({workloadRootInfo:{uid},imageInfo:{digest,registry:"docker.io",repository:"library/python"}} as ImageUsage)
 const rows=[usage("app","sha256:one"),usage("app","sha256:one"),usage("app","sha256:two"),usage("another","sha256:one")]
 assert.deepEqual(selectedImageUsages("/topmost-owners/app/images/sha256%3Aone",rows),rows.slice(0,2))
 assert.deepEqual(selectedImageUsages("/topmost-owners/app",rows),rows.slice(0,3))
 assert.equal(selectedImageUsages("/vulnerabilities",rows),rows)
 assert.equal(selectedImageUsages("/vulnerabilities/CVE-2026-1234",rows),rows)
 assert.deepEqual(selectedImageUsages("/container-images/docker.io/library/python",rows),rows)
})

test("issue list views load build metadata without requesting scan details",()=>{
 const usage=(owner:string,uid:string,namespace:string,finished=false)=>({uid,namespace,finished,workloadRootInfo:{uid:owner}} as ImageUsage)
 const rows=[usage("a","p1","one"),usage("a","p2","one"),usage("b","p3","two"),usage("a","old","one",true)]
 assert.deepEqual(selectedImageMetadataUsages("/topmost-owners",rows),rows.slice(0,3))
 assert.deepEqual(selectedImageMetadataUsages("/container-images",rows),rows.slice(0,3))
 assert.deepEqual(selectedImageUsages("/container-images",rows),[])
 assert.deepEqual(selectedImageMetadataUsages("/topmost-owners/a",rows),[rows[0],rows[1],rows[3]])
 assert.deepEqual(selectedImageMetadataUsages("/topmost-owners/a/p2",rows),[rows[1]])
 assert.deepEqual(selectedImageMetadataUsages("/namespaces/one",rows),rows.slice(0,2))
 assert.deepEqual(selectedImageMetadataUsages("/executive-summary",rows),[])
 assert.deepEqual(selectedImageUsages("/topmost-owners",rows),[])
})

test("resource overview findings load only running images in their scope",()=>{
 const usage=(owner:string,uid:string,namespace:string,finished=false)=>({uid,namespace,finished,workloadRootInfo:{uid:owner}} as ImageUsage)
 const rows=[usage("a","p1","one"),usage("a","p2","one"),usage("b","p3","two"),usage("a","old","one",true)]
 for(const suffix of ["","/"]){
  assert.deepEqual(selectedImageUsages(`/namespaces/one${suffix}`,rows),rows.slice(0,2))
  assert.deepEqual(selectedImageUsages(`/topmost-owners/a${suffix}`,rows),rows.slice(0,2))
  assert.deepEqual(selectedImageUsages(`/topmost-owners/a/p2${suffix}`,rows),[rows[1]])
 }
 for(const path of ["/namespaces/one/logs","/topmost-owners/a/logs","/topmost-owners/a/network-topology","/topmost-owners/a/p2/logs","/executive-summary"]){
  assert.deepEqual(selectedImageUsages(path,rows),[])
 }
})
