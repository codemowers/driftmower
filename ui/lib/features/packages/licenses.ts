import {licenses} from "../crawler/license-data.ts"

// Trivy's free-form license names can contain paragraphs or opening lines.
// Only recognized SPDX identifiers belong in the compact inline summary.
export function packageLicenses(values:string[]=[]){
 const unique=[...new Set(values.map(v=>v.trim()).filter(Boolean))]
 return {identifiers:unique.filter(v=>Object.hasOwn(licenses,v)).sort(),other:unique.filter(v=>!Object.hasOwn(licenses,v))}
}
