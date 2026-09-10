import { emitYamlLines, textLines, yamlText, type YamlLine } from "@/lib/features/yaml/yaml-lines"
import type { PlanObject } from "./types"

// One renderer serves both facades: DocumentViewer consumes the lines (and
// renders each note beside its line), while the MCP tools and the kubectl
// heredoc take yamlText() of the same lines. No YAML dependency ships.

function headerFor(object: PlanObject, total: number): string {
  return `# ${object.index}/${total} ${object.kind} ${object.name} — ${object.does}`
}

// The recipe's notes are keyed by jsonpath, matching emitYamlLines' default
// pathStyle (e.g. "spec.storage.storageClass").
function annotatorFor(notes: Record<string, string>) {
  return (path: string) => {
    const note = notes[path]
    return note ? { note } : null
  }
}

export function manifestLines(objects: PlanObject[]): YamlLine[] {
  const total = objects.length
  const lines: YamlLine[] = []

  for (const [i, object] of objects.entries()) {
    // A document separator before every document but the first keeps the output
    // valid for `kubectl apply -f -` however many objects a preset emits.
    if (i > 0) lines.push(...textLines("---"))
    lines.push(...textLines(headerFor(object, total)))
    if (object.optional) {
      lines.push(...textLines(`# optional — remove this document to leave it out`))
    }
    lines.push(...emitYamlLines(object.object, { annotate: annotatorFor(object.notes) }))
  }

  return lines
}

export function manifestText(objects: PlanObject[]): string {
  return yamlText(manifestLines(objects))
}
