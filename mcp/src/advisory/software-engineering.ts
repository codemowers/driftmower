import { readdirSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface EngineeringAdvisory {
  source: 'bundled' | 'override'
  path: string
  title: string
  text: string
}

// Load once at startup, relative to this module in both source and compiled builds.
function loadAdvisories(
  directory: URL,
  source: EngineeringAdvisory['source'] = 'bundled',
  prefix = '',
  ancestors = new Set<string>()
): EngineeringAdvisory[] {
  const realDirectory = realpathSync(directory)

  if (ancestors.has(realDirectory)) throw new Error(`Advisory directory cycle: ${directory.pathname}`)

  const parents = new Set([...ancestors, realDirectory])

  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap(entry => {
      // Kubernetes projected ConfigMaps include hidden ..data directories.
      if (entry.name.startsWith('.')) return []

      const path = `${prefix}${entry.name}`
      const file = new URL(encodeURIComponent(entry.name), directory)

      const info = entry.isSymbolicLink() ? statSync(file) : entry

      if (info.isDirectory()) {
        return loadAdvisories(
          new URL(`${encodeURIComponent(entry.name)}/`, directory),
          source,
          `${path}/`,
          parents
        )
      }

      if (!entry.name.endsWith('.md')) return []

      if (!info.isFile()) return []

      const markdown = readFileSync(file, 'utf8')
      const heading = /^# ([^\r\n]+)\r?\n(?:\r?\n)?/.exec(markdown)

      if (!heading) throw new Error(`Advisory ${path} must start with a Markdown title`)

      const apiPath = path.slice(0, -3)

      if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*(?:\/[a-z0-9-]+(?:\.[a-z0-9-]+)*)*$/.test(apiPath))
        throw new Error(`Invalid advisory path: ${apiPath}`)

      if (apiPath === 'index') throw new Error('The advisory index is generated automatically')

      return [{ source, path: apiPath, title: heading[1], text: markdown.slice(heading[0].length).trimEnd() }]
    })
}

export const ENGINEERING_ADVISORIES = loadAdvisories(new URL('./content/', import.meta.url))

if (ENGINEERING_ADVISORIES.length === 0) throw new Error('No engineering advisory Markdown files found')

export function advisoryUri(path: string): string {
  return `engineering://advisory/${path}`
}

export function advisoryMarkdown(section: { title: string; text: string }): string {
  return `# ${section.title}\n\n${section.text}\n`
}

// A configured but unreadable directory is a startup error, not a silent fallback.
export function loadEngineeringAdvisories(overrideDirectory: string | null): EngineeringAdvisory[] {
  if (!overrideDirectory) return ENGINEERING_ADVISORIES

  const sections = new Map(ENGINEERING_ADVISORIES.map(section => [section.path, section]))
  const directory = pathToFileURL(resolve(overrideDirectory) + sep)

  for (const section of loadAdvisories(directory, 'override')) sections.set(section.path, section)

  return [...sections.values()].sort((a, b) => a.path.localeCompare(b.path))
}
