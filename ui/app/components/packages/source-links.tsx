import {packageSources} from "@/lib/features/packages/sources"

export default function PackageSourceLinks({purl}:{purl:string}){
 const links=packageSources(purl)
 return <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">{links.map(link=><a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="text-brand-text hover:underline" title={link.kind==="repository"?"Best-effort repository hint; the SBOM does not verify this source association.":"Package registry/documentation link; not source provenance."}>{link.label}{link.kind==="repository"?` (${link.basis})`:""}</a>)}{!links.length&&<span className="text-muted-foreground">Source repository unknown</span>}</div>
}
