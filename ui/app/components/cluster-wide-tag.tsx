// Marks a stat that comes pre-computed from the report and cannot be
// re-scoped client-side; shown when a sandbox context is selected so
// cluster numbers are never mistaken for sandbox-scoped ones.
export default function ClusterWideTag() {
  return (
    <span
      className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
      title="Computed across the whole cluster; not scoped to the selected sandbox"
    >
      cluster-wide
    </span>
  )
}
