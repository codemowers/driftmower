import { readFile, writeFile } from "node:fs/promises"
const root = new URL("../", import.meta.url)
const source = new URL("vendor/spdx-license-list-data/json/licenses.json", root)
let data
try {
  data = JSON.parse(await readFile(source, "utf8"))
} catch (error) {
  if (error.code === "ENOENT") throw new Error("SPDX submodule missing. Run git submodule update --init --recursive before building.", { cause: error })
  throw error
}
const licenses = Object.fromEntries(data.licenses.map(license => [license.licenseId, { title: license.name, osi: license.isOsiApproved }]))
await writeFile(new URL("lib/features/crawler/license-data.ts", root), `// Generated from SPDX license-list-data (${data.licenseListVersion}); do not edit.\nexport const licenses: Record<string, { title: string; osi: boolean }> = ${JSON.stringify(licenses)}\n`)
