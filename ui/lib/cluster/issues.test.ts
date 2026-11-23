import assert from "node:assert/strict"
import { test } from "node:test"
import { driftIssues, imageAgeSeverity, issueCounts, issueRank, namespaceIssues, type WorkloadIssue } from "./issues.ts"
import type { ClusterResource } from "./cluster-state"
import type { ImageUsage, StatusType } from "./reports"

test("namespace indicators combine security and resources without counting workload summaries twice", () => {
  const root: WorkloadIssue = { code: "root", severity: "critical", message: "Container app runs as UID 0" }
  const memory: WorkloadIssue = { code: "missing-memory-limit", severity: "warning", message: "Container app has no memory limit" }
  const pods: ClusterResource[] = [
    { uid: "a", kind: "Pod", name: "a", namespace: "team", issues: [root, memory] },
    { uid: "b", kind: "Pod", name: "b", namespace: "team", issues: [root] },
    { uid: "owner", kind: "Deployment", name: "owner", namespace: "team", issues: [{ ...root, podCount: 2 }] },
    { uid: "c", kind: "Pod", name: "c", namespace: "other", issues: [memory] },
  ]
  const result = namespaceIssues([...pods, pods[0]])
  assert.deepEqual(result.get("team"), [{ ...root, podCount: 2 }, { ...memory, podCount: 1 }])
  assert.deepEqual(result.get("other"), [{ ...memory, podCount: 1 }])
  assert.equal(root.podCount, undefined)
})

const usage = (repository: string, statusType: StatusType, finished = false): ImageUsage => ({
  finished,
  imageInfo: { registry: "example.com", repository, tag: "1.0.0" },
  versionStatus: { statusType, deployedTag: "1.0.0", latestTag: "2.1.1", majorDifference: 1, minorDifference: 1, patchDifference: 1 },
} as ImageUsage)

test("drift issues retain the worst running version per repository and distinguish drift kinds", () => {
  const result = driftIssues([
    usage("major", "patch_behind"), usage("major", "major_behind"), usage("major", "major_behind"),
    usage("minor", "minor_behind"), usage("patch", "patch_behind"), usage("stale", "behind"),
    usage("finished", "major_behind", true), usage("unknown", "no_data"), usage("unversioned", "no_version"),
    usage("current", "up_to_date"), usage("ahead", "ahead"),
  ])
  assert.deepEqual(result.map(i => [i.code, i.severity]), [
    ["major-version", "warning"], ["minor-version", "notice"], ["patch-version", "info"], ["version-behind", "notice"],
  ])
  assert.match(result[0].message, /example.com\/major 1\.0\.0 → 2\.1\.1/)
  assert.equal(driftIssues([usage("unknown", "no_data")]).length, 0)
})

test("issue rank weighs severity and breadth, discounts repeated kinds and ignores replica counts", () => {
  const critical: WorkloadIssue = { code: "privileged", severity: "critical", message: "Privileged" }
  const major = driftIssues([usage("app", "major_behind")])[0]
  const minor = driftIssues([usage("app", "minor_behind")])[0]
  const patch = driftIssues([usage("app", "patch_behind")])[0]
  assert.ok(issueRank([critical]).score > issueRank([major, minor, patch]).score)
  assert.ok(issueRank([major]).score > issueRank([minor]).score)
  assert.ok(issueRank([minor]).score > issueRank([patch]).score)
  assert.ok(issueRank([major, minor]).score > issueRank([major]).score)
  assert.ok(issueRank([major, { ...major, message: "another image" }, { ...major, message: "third image" }]).score < 3 * issueRank([major]).score)
  assert.deepEqual(issueRank([{ ...critical, podCount: 100 }]), issueRank([critical]))
  assert.deepEqual(issueRank([]), { score: 0, worst: undefined })
})

const NOW = Date.parse("2026-11-20T12:00:00Z")
const MONTH = 365.25 * 86_400_000 / 12
const aged = (months:number, status:StatusType="no_data", uid="pod") => ({
 ...usage("app",status),uid,containerName:"private-container-name",context:"cluster",namespace:"team",
 imageInfo:{...usage("app",status).imageInfo,labels:{"org.opencontainers.image.created":new Date(NOW-months*MONTH).toISOString()}},
} as ImageUsage)

test("build-age severity progresses from six months to critical at two years",()=>{
 for(const [months,want] of [[0,null],[6,null],[6.01,"info"],[11.99,"info"],[12,"notice"],[17.99,"notice"],[18,"warning"],[23.99,"warning"],[24,"critical"],[60,"critical"],[-1,null],[NaN,null],[Infinity,null]] as const){
  assert.equal(imageAgeSeverity(months),want,`${months} months`)
 }
})

test("stale images are reported even without releases and independently of current versions",()=>{
 const fresh=aged(6)
 const old=aged(25)
 const medium=aged(13,"up_to_date","other")
 const finished={...aged(60),finished:true}
 const findings=driftIssues([fresh,old,old,medium,finished],NOW)
 assert.equal(findings.length,1)
 assert.equal(findings[0].code,"stale-image")
 assert.equal(findings[0].severity,"critical")
 assert.equal(findings[0].containerCount,2)
 assert.match(findings[0].message,/25 months/)
 assert.doesNotMatch(findings[0].message,/private-container-name/)
 assert.equal(driftIssues([aged(6,"up_to_date")],NOW).length,0)
 assert.equal(driftIssues([aged(25,"up_to_date")],NOW)[0].severity,"critical")
 assert.deepEqual(driftIssues([aged(25,"major_behind")],NOW).map(i=>i.code),["major-version","stale-image"])
})

test("missing, invalid and future build dates do not fabricate staleness",()=>{
 for(const date of [undefined,"","invalid",new Date(NOW+MONTH).toISOString()]){
  const u=aged(25)
  u.imageInfo.labels=date===undefined?undefined:{"org.opencontainers.image.created":date}
  assert.equal(driftIssues([u],NOW).length,0)
 }
 assert.equal(driftIssues([usage("uncomparable","behind")],NOW)[0].code,"version-behind")
})

test("namespace issues sum affected containers across distinct Pods and format counts",()=>{
 const issue:WorkloadIssue={code:"missing-cpu-limit",severity:"warning",message:"Containers have no cpu limit",containerCount:2}
 const pod=(uid:string,count:number)=>({uid,kind:"Pod",name:uid,namespace:"team",issues:[{...issue,containerCount:count}]}) as ClusterResource
 const a=pod("a",2)
 const result=namespaceIssues([a,pod("b",1),a]).get("team")!
 assert.deepEqual(result,[{...issue,containerCount:3,podCount:2}])
 assert.equal(issueCounts(result[0]),"3 containers · 2 Pods")
 assert.equal(issueCounts({...issue,containerCount:1,podCount:1}),"1 container · 1 Pod")
 assert.equal(issueCounts({...issue,containerCount:undefined}),"")
 assert.deepEqual(issueRank(result),issueRank([{...issue,containerCount:1000,podCount:1000}]))
})

test("default-backend without an OCI label uses its eight-year-old config creation time",()=>{
 const u={...usage("default-backend","no_data"),uid:"backend",containerName:"backend",imageInfo:{...usage("default-backend","no_data").imageInfo,configCreated:"2018-09-28T17:05:09Z"}} as ImageUsage
 const issues=driftIssues([u],NOW)
 assert.equal(issues.length,1)
 assert.equal(issues[0].code,"stale-image")
 assert.equal(issues[0].severity,"critical")
 assert.match(issues[0].message,/97 months/)
 // The created label retains the same priority as the image age display.
 u.imageInfo.labels={"org.opencontainers.image.created":new Date(NOW-MONTH).toISOString()}
 assert.equal(driftIssues([u],NOW).length,0)
 u.imageInfo.labels={"org.opencontainers.image.created":"invalid"}
 assert.equal(driftIssues([u],NOW)[0].severity,"critical")
})
