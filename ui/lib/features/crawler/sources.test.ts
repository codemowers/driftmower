import assert from "node:assert/strict"
import test from "node:test"
import { scrapeState } from "./sources.ts"

test("scrape status distinguishes absent, pending, active, failed and overdue data",()=>{
 const checkedAt="2026-01-01T00:00:00Z",nextCrawl="2026-01-02T00:00:00Z",now=Date.parse("2026-01-01T12:00:00Z")
 assert.equal(scrapeState(undefined,now),"unknown")
 assert.equal(scrapeState({},now),"pending")
 assert.equal(scrapeState({scraping:true,errors:["old failure"]},now),"scraping")
 assert.equal(scrapeState({checkedAt,errors:["429"]},now),"failed")
 assert.equal(scrapeState({checkedAt,nextCrawl},now),"ready")
 assert.equal(scrapeState({checkedAt,nextCrawl},Date.parse("2026-01-03")),"due")
})

test("source detail links preserve the complete source URL and reject unsafe upstream links",async()=>{
 const {sourceRepositoryPath,safeSourceURL}=await import("./sources.ts")
 const url="https://github.com/example/app?branch=feature%2Fone"
 assert.equal(decodeURIComponent(sourceRepositoryPath(url).slice("/source-repositories/".length)),url)
 assert.equal(safeSourceURL(url),url)
 assert.equal(safeSourceURL("javascript:alert(1)"),undefined)
 assert.equal(safeSourceURL("https://user:secret@example.com/repo"),undefined)
})
