// Discovery, observability and advisory tools are read-only. Optional workload
// actions declare their own mutating annotations.
//
// Shared so the set cannot drift per tool: a client deciding whether to
// auto-approve a call reads these, and a tool that silently omits them reads as
// unknown rather than safe.
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const
