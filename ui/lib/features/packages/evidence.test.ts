import test from "node:test"
import assert from "node:assert/strict"
import {packageSources,imageFilePath} from "./sources.ts"
import {packageLicenses} from "./licenses.ts"
import {lifecycleTimeline,lifecycleState} from "./lifecycle.ts"
import {filterPackages,type Lifecycle,type PackageSummary} from "./types.ts"

test("source hints preserve package scope and avoid arbitrary npm owner guesses",()=>{
 assert.equal(packageSources("pkg:npm/react@18.3.1")[0].url,"https://github.com/react/react")
 assert.equal(packageSources("pkg:npm/%40types/express@5.0.0").some(x=>x.kind==="repository"),false)
 assert.equal(packageSources("pkg:npm/%40unknown/example").some(x=>x.kind==="repository"),false)
 assert.equal(packageSources("pkg:golang/github.com/example/project/submodule/v2@v2.3.0")[0].url,"https://github.com/example/project")
 assert.equal(packageSources("pkg:golang/gitlab.com/group/subgroup/project@v1")[0].kind,"registry")
 assert.equal(packageSources("pkg:bitbucket/team/project")[0].url,"https://bitbucket.org/team/project")
 for(const malformed of ["javascript:alert(1)","pkg:npm/%ZZ","pkg:github/owner/../secret","pkg:github/owner/%2e%2e"]){assert.deepEqual(packageSources(malformed),[])}
 assert.equal(imageFilePath("app/node_modules/react/package.json"),"/app/node_modules/react/package.json")
 assert.equal(imageFilePath("/usr/lib/package"),"/usr/lib/package")
})
test("inline licenses use recognized SPDX IDs and preserve prose separately",()=>{
 const prose="Permission is hereby granted, free of charge, to any person obtaining"
 assert.deepEqual(packageLicenses([prose,"GPL-2.0-only","MIT","MIT"]),{identifiers:["GPL-2.0-only","MIT"],other:[prose]})
})
test("lifecycle filters match any observed state, including mixed-version packages",()=>{
 const row=(id:string,states:string[]):PackageSummary=>({id,name:id,ecosystem:"npm",versions:states.length,images:1,vulnerabilities:0,tags:["framework"],lifecycleStates:states})
 const mixed=row("mixed",["supported","end-of-life"]),unknown=row("unknown",["unknown"]),rows=[mixed,unknown]
 assert.deepEqual(filterPackages(rows,"",[],["end-of-life"]),[mixed])
 assert.deepEqual(filterPackages(rows,"",[],["supported"]),[mixed])
 assert.deepEqual(filterPackages(rows,"",[],["unknown"]),[unknown])
 assert.equal(filterPackages(rows,"mixed",["framework"],["unknown"]).length,0)
 assert.equal(filterPackages(rows,"",[],["unknown","supported"]).length,2)
 assert.equal(lifecycleState({...{} as Lifecycle,state:"maintenance"}),"supported")
 assert.equal(lifecycleState(),"unknown")
})
test("timeline uses published dates and keeps unknown maintenance boundaries unknown",()=>{
 const value={released:"2020-01-01",activeSupportEnd:"2022-01-01",eol:"2024-01-01"} as Lifecycle
 const timeline=lifecycleTimeline(value,Date.parse("2025-01-01T00:00:00Z"))!
 assert.deepEqual(timeline.segments.map(s=>s.phase),["active","maintenance","eol"])
 assert.ok(timeline.today>timeline.eol!)
 assert.ok(timeline.today<100)
 const partial=lifecycleTimeline({released:value.released,eol:value.eol} as Lifecycle)!
 assert.deepEqual(partial.segments.map(s=>s.phase),["active","eol"])
 assert.equal(lifecycleTimeline({eol:value.eol} as Lifecycle),undefined)
 assert.equal(lifecycleTimeline({released:"2020-02-31"} as Lifecycle),undefined)
})
