import {packageLicenses} from "@/lib/features/packages/licenses"
import LicenseBadge from "@/app/components/license-badge"

export default function PackageLicenseEvidence({values}:{values?:string[]}){
 const licenses=packageLicenses(values)
 return <div className="flex flex-col gap-2"><div className="flex flex-wrap gap-1">{licenses.identifiers.map(id=><LicenseBadge key={id} license={{spdxId:id}}/>)}{!licenses.identifiers.length&&<span className="text-xs text-muted-foreground">No recognized SPDX license identifier</span>}</div>{licenses.other.length>0&&<details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Other license evidence ({licenses.other.length})</summary><ul className="mt-2 max-h-48 list-disc space-y-1 overflow-auto pl-4">{licenses.other.map(value=><li key={value} className="whitespace-pre-wrap break-words">{value}</li>)}</ul></details>}</div>
}
