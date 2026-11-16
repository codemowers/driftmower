import { licenses } from "./license-data.ts"
import type { RepositoryLicense } from "./sources.ts"

// Copyleft and OSI approval overlap. Copyleft takes the yellow badge while
// approval is reported independently in the detail view.
const copyleft = /^(?:A?GPL|LGPL|MPL|EPL|CDDL|EUPL|OSL|CPL|RPL|QPL|NPL|Sleepycat|Watcom|CECILL)(?:-|$)/i
export function classifyLicense(license?: RepositoryLicense) {
  const id = license?.spdxId ?? (license?.name && licenses[license.name] ? license.name : undefined)
  const known = id ? licenses[id] : undefined
  const classification = !id || id === "NOASSERTION" ? "Unknown"
    : id === "BUSL-1.1" ? "BSL"
    : copyleft.test(id) ? "Copyleft"
    : id.startsWith("SSPL-") ? "SSPL"
    : /^(?:Elastic-|FSL-|PolyForm-)/.test(id) ? "Source available"
    : known?.osi ? "OSI approved" : "Other"
  const tone = classification === "Copyleft" || classification === "BSL" || classification === "SSPL" || classification === "Source available" ? "yellow"
    : known?.osi ? "green" : "neutral"
  return { classification, tone, osi: known?.osi ?? false, title: known?.title ?? license?.name ?? "Not reported" }
}
