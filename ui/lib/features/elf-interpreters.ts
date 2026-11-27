import type { ImageAnalysis } from "./image-analysis"

type Binary = ImageAnalysis["binaries"][number]
export type InterpreterGroup = {
  key: string
  architecture: string
  label: string
  family?: string
  binaries: Binary[]
}

export function interpreterGroups(binaries: Binary[]): InterpreterGroup[] {
  const groups = new Map<string, InterpreterGroup>()
  for (const binary of binaries) {
    const architecture = binary.architecture || "Unknown architecture"
    // An unreadable or partially parsed ELF must never become a static binary.
    const label = binary.error ? "Unknown / inspection failed"
      : binary.interpreter ? binary.interpreter
      : binary.linking === "static" ? "Static executable · no interpreter"
      : binary.linking === "shared object" ? "Shared object · no interpreter recorded"
      : binary.linking === "dynamic" ? "Dynamic · no interpreter recorded"
      : "Unknown linking"
    const name = binary.interpreter?.split("/").pop() || ""
    const family = !binary.error && binary.interpreter
      ? /^ld-musl-[\w.-]+\.so\.1$/.test(name) ? "musl-style loader name"
        : /^ld-linux[\w.-]*\.so\.\d+$/.test(name) ? "glibc-style loader name" : "Other loader"
      : undefined
    const key = JSON.stringify([architecture, label])
    let group = groups.get(key)
    if (!group) {
      group = { key, architecture, label, family, binaries: [] }
      groups.set(key, group)
    }
    group.binaries.push(binary)
  }
  return [...groups.values()].sort((a, b) => a.architecture.localeCompare(b.architecture) || a.label.localeCompare(b.label))
    .map(group => ({ ...group, binaries: [...group.binaries].sort((a, b) => a.path.localeCompare(b.path)) }))
}
