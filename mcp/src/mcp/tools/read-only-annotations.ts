// Nothing in this server writes. Every tool reads a Driftmower snapshot or
// relays driftmower-ui's capability layer; the planners render text for a human
// to apply, they never apply anything themselves.
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
