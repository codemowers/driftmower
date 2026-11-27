"use client"
import { useCallback } from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import Page from "@/app/components/layout/page"
import Card from "@/app/components/layout/card"
import ResourceHeader from "@/app/components/resource-header"
import { ICONS } from "@/app/components/layout/icons"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { useQuery } from "@/lib/hooks/use-query"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { callTool } from "@/browser/connection"
import { containerImageHref } from "@/lib/utils/image-artifacts"
import { imageFilePath } from "@/lib/features/packages/sources"
import { packageName, type PackagesResult } from "@/lib/features/packages/types"
import { PackageCoverage, PackageTags } from "@/app/components/packages/evidence"
import PackageSourceLinks from "@/app/components/packages/source-links"
import PackageLicenseEvidence from "@/app/components/packages/license-evidence"
import LifecycleTimeline from "@/app/components/packages/lifecycle-timeline"

export default function PackagePage(){
 const {purl}=useParams<{purl:string}>(),{linkTo}=useContextHref(),cluster=useClusterState(s=>s.clusterName)
 const load=useCallback((signal:AbortSignal)=>callTool<PackagesResult>("get_package",{purl},signal),[purl])
 const result=useQuery({key:JSON.stringify([cluster,"package",purl]),load,interval:30_000})
 const pkg=result.data?.packages[0],occurrences=result.data?.occurrences??[]
 const versions=[...new Set(occurrences.map(o=>o.version??""))].sort()
 return <Page>
  <ResourceHeader icon={ICONS.packages} iconAriaLabel="Package" title={packageName(pkg?.name??purl)} copyValue={purl} breadcrumbs={[{label:"Packages",href:linkTo("/packages")},{label:packageName(pkg?.name??purl)}]} subtitle={packageName(purl)}/>
  {pkg&&<PackageTags tags={pkg.tags}/>}
  <PackageSourceLinks purl={purl}/>
  <PackageCoverage data={result.data}/>
  {result.loading&&<p className="text-sm text-muted-foreground">Loading package evidence…</p>}
  {result.error&&<p role="alert" className="text-sm text-status-major-label">Package unavailable: {result.error} <button onClick={result.retry} className="underline">Retry</button></p>}
  {versions.map(version=>{
   const rows=occurrences.filter(o=>(o.version??"")===version)
   const lifecycle=rows.find(o=>o.lifecycle?.cycle)?.lifecycle??rows[0]?.lifecycle
   return <Card key={version} title={<span>Version <span className="font-mono">{version||"unknown"}</span></span>} meta={`${new Set(rows.map(o=>o.digest)).size} images`} flush>
    <LifecycleTimeline value={lifecycle} version={version}/>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-muted text-xs text-muted-foreground"><tr>{["Package evidence","Used by","Vulnerabilities"].map(h=><th key={h} className="px-5 py-3">{h}</th>)}</tr></thead><tbody>
     {rows.map(o=><tr key={`${o.digest}/${o.platformDigest}/${o.purl}`} className="border-b align-top last:border-0">
      <td className="max-w-xl px-5 py-3"><p className="break-all font-mono text-xs">{packageName(o.purl)}</p>{o.paths?.map(path=><p key={path} className="mt-1 break-all text-xs text-muted-foreground">Path in image: <span className="font-mono">{imageFilePath(path)}</span></p>)}<p className="mt-1 text-xs text-muted-foreground">{o.coverage}{o.reason?` · ${o.reason}`:""} · {o.scannedAt?new Date(o.scannedAt).toLocaleString():"Scan time unknown"}</p></td>
      <td className="max-w-md px-5 py-3"><Link href={linkTo(containerImageHref(o.repository,o.digest))} className="break-all text-brand-text hover:underline">{o.image.split("@")[0]}</Link><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{o.platformDigest}</p></td>
      <td className="px-5 py-3"><div className="flex max-w-sm flex-wrap gap-x-3 gap-y-1">{o.findings?.length?[...new Set(o.findings.map(v=>v.id))].sort().map(id=><Link key={id} href={linkTo(`/vulnerabilities/${encodeURIComponent(id)}`)} className="font-mono text-xs text-brand-text hover:underline">{id}</Link>):<span className="text-xs text-muted-foreground">None reported{o.coverage!=="complete"?"; coverage incomplete":""}</span>}</div></td>
     </tr>)}
    </tbody></table></div>
    <div className="border-t px-5 py-3"><p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Licenses</p><PackageLicenseEvidence values={rows.flatMap(o=>o.licenses??[])}/></div>
   </Card>
  })}
  {result.data&&!occurrences.length&&<p className="text-sm text-muted-foreground">This package is not present in the available SBOMs of running images.</p>}
 </Page>
}
