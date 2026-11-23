import { scrapeState, type SourceScrape } from "@/lib/features/crawler/sources"
import IssueIndicator from "./issue-indicator"

export default function SourceScrapeBadge({scrape}:{scrape?:SourceScrape}){
 if(scrapeState(scrape)==="unauthorized")return <span title={scrape?.errors?.join("\n") || "Crawler credentials cannot access this repository"} className="rounded bg-status-minor-bg px-2 py-0.5 text-xs font-semibold text-status-minor-label">Unauthorized</span>
 const issues=[...new Set(scrape?.errors??[])].map(message=>({code:"scrape",severity:"warning" as const,message}))
 return <IssueIndicator issues={issues}/>
}
