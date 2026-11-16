import { scrapeState, type SourceScrape } from "@/lib/features/crawler/sources"
import { compactRelativeTimeFromNow } from "@/lib/utils/format-time"
import { cn } from "@/lib/utils/cn"

const styles={unknown:"bg-muted text-muted-foreground",pending:"bg-muted text-muted-foreground",scraping:"bg-brand-bg text-brand-label",failed:"bg-status-major-bg text-status-major-label",due:"bg-status-minor-bg text-status-minor-label",ready:"bg-status-ok-bg text-status-ok-label"}
const labels={unknown:"Status unavailable",pending:"Not scraped",scraping:"Scraping",failed:"Scrape failed",due:"Scrape due",ready:"Scraped"}
export default function SourceScrapeBadge({scrape}:{scrape?:SourceScrape}){
 const state=scrapeState(scrape)
 return <span className={cn("inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium",styles[state])} title={[scrape?.checkedAt,...(scrape?.errors??[])].filter(Boolean).join("\n")}>{labels[state]}{scrape?.checkedAt?` · ${compactRelativeTimeFromNow(scrape.checkedAt)}`:""}</span>
}
