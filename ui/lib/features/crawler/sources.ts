export type SourceRepository = { name?: string; url: string; images?: string[] }
export type SourceScrape = { checkedAt?: string; nextCrawl?: string; errors?: string[]; scraping?: boolean; unauthorized?: boolean }
export function scrapeState(scrape?:SourceScrape,now=Date.now()):"unknown"|"scraping"|"pending"|"failed"|"unauthorized"|"due"|"ready"{
 if(!scrape)return "unknown"
 if(scrape.scraping)return "scraping"
 if(!scrape.checkedAt||!Number.isFinite(Date.parse(scrape.checkedAt)))return "pending"
 if(scrape.unauthorized)return "unauthorized"
 if(scrape.errors?.length)return "failed"
 if(scrape.nextCrawl&&Date.parse(scrape.nextCrawl)<=now)return "due"
 return "ready"
}

export type RepositoryLicense={spdxId?:string;name?:string;url?:string}
export function licenseLabel(license?:RepositoryLicense){return license?.spdxId&&license.spdxId!=="NOASSERTION"?license.spdxId:license?.name||"Not reported"}
export type SourceRelease={tag:string;notes?:string;url?:string;published?:string}
export type SourceRecord=SourceScrape&{releases?:SourceRelease[];license?:RepositoryLicense;url:string;latest?:{tag:string};deployed:{version:string}[]}
export type SourceImage={name:string;digest?:string;image?:string;version?:string;references:string[];unused:boolean}
export type SourceImages={images:SourceImage[]}
export function sourceRepositoryPath(url:string){return `/source-repositories/${encodeURIComponent(url)}`}
export function safeSourceURL(raw?:string):string|undefined{
 try{const url=new URL(raw??"");if(["https:","http:"].includes(url.protocol)&&!url.username&&!url.password)return raw}catch{/* Display unsupported source references as text. */}
}
