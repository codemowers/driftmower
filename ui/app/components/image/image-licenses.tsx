"use client"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { classifyLicense } from "@/lib/features/crawler/license"
import { safeSourceURL } from "@/lib/features/crawler/sources"
import LicenseBadge from "@/app/components/license-badge"

export default function ImageLicenses({ digests }: { digests: string[] }) {
  const reports = useClusterState(state => state.vulnerabilityReports)
  const statuses = useClusterState(state => state.imageScanStatuses)
  return <section className="space-y-3 rounded-xl border bg-white p-5"><h2 className="text-sm font-semibold">Licenses from SBOM</h2><p className="text-xs text-muted-foreground">Image metadata and component licenses reported by the scanner. Dependency licenses describe individual components.</p>
    {digests.map(digest => {
      const report = reports?.[digest]
      const licenses = report?.report.licenses ?? []
      return <div key={digest} className="space-y-2">{digests.length > 1 && <p className="break-all font-mono text-xs text-muted-foreground">{digest}</p>}
        {!report ? <p className="text-xs text-muted-foreground">{!statuses[digest] || statuses[digest] === "loading" ? "Loading SBOM licenses…" : "SBOM unavailable for this image."}</p> : !licenses.length ? <p className="text-xs text-muted-foreground">No license information was reported in this SBOM.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="py-2 pr-4">License</th><th className="py-2 pr-4">Classification</th><th className="py-2">Scope</th></tr></thead><tbody>{licenses.map((license,index) => {
          const metadata = { spdxId:license.id, name:license.name ?? license.expression, url:license.url }
          const info = classifyLicense(metadata)
          return <tr key={index} className="border-b align-top last:border-0"><td className="py-2 pr-4"><LicenseBadge license={metadata}/><p className="mt-1 text-xs text-muted-foreground">{info.title}</p>{safeSourceURL(license.url??"")&&<a href={license.url} target="_blank" rel="noreferrer" className="text-xs text-brand-text hover:underline">License text</a>}</td><td className="py-2 pr-4 text-xs">{license.expression ? "SPDX expression" : info.classification}{info.osi&&info.classification!=="OSI approved"?" · OSI approved":""}</td><td className="py-2 text-xs">{license.scope==="image"?"Image metadata":`${license.componentCount} components`}<p className="mt-1 break-all font-mono text-muted-foreground">{license.examples.join(", ")}{license.componentCount>3?` · +${license.componentCount-3} more`:""}</p></td></tr>
        })}</tbody></table></div>}
      </div>
    })}
    {!digests.length&&<p className="text-xs text-muted-foreground">No image digest is available.</p>}
  </section>
}
