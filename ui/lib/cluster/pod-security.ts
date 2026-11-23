import type { ClusterResource } from "./cluster-state"

export type PodSecurity = {
  isolationRank: number
  runtimeClassName?: string
  sandboxed: boolean
  user: "root" | "nonroot" | "image"
  userNamespace?: boolean
  privileged?: string[]
  hostNamespaces?: string[]
  addedCapabilities?: string[]
}

export type Chip = { label: string; className: string; title?: string; href?: string }

const OK = "bg-status-ok-bg text-status-ok-label"
const YELLOW = "bg-status-patch-bg text-status-patch-label"
const ORANGE = "bg-status-minor-bg text-status-minor-label"
const RED = "bg-status-major-bg text-status-major-label"
const MUTED = "bg-gray-100 text-muted-foreground"

// How isolated a Pod is from its host, worst first.
const ISOLATION: { label: string; className: string; title: string }[] = [
  { label: "root", className: RED, title: "A container runs as UID 0 on the host kernel" },
  { label: "may run as root", className: RED, title: "No runAsUser or runAsNonRoot is set, so the container runs as its image's USER, which may be root, on the host kernel" },
  { label: "user namespace", className: YELLOW, title: "hostUsers: false: the image's user, root included, maps to an unprivileged host UID" },
  { label: "rootless", className: OK, title: "Every container sets a non-zero runAsUser or runAsNonRoot, but shares the host kernel" },
  { label: "kata", className: OK, title: "Runs in a Kata Containers VM with its own kernel" },
]

// Chips for how a workload's Pods run: the least isolated Pod's isolation,
// then privileges beyond the defaults.
export function runtimeChips(pods: ClusterResource[]): Chip[] {
  const analyzed = pods.filter(p => p.security && Number.isInteger(p.security.isolationRank) && p.security.isolationRank >= 0 && p.security.isolationRank < ISOLATION.length)
  if (analyzed.length === 0) return []
  const levels = analyzed.map(p => p.security!.isolationRank)
  const worst = Math.min(...levels)
  const count = levels.filter(l => l === worst).length
  const chip = ISOLATION[worst]
  const chips: Chip[] = [{ ...chip, label: count === analyzed.length ? chip.label : `${chip.label} ${count}/${analyzed.length}` }]

  if (analyzed.some(p => !p.security!.sandboxed && p.security!.privileged?.length)) chips.push({ label: "privileged", className: RED })
  for (const ns of new Set(analyzed.flatMap(p => p.security!.hostNamespaces ?? []))) chips.push({ label: ns, className: RED })
  for (const cap of new Set(analyzed.filter(p => !p.security!.sandboxed).flatMap(p => p.security!.addedCapabilities ?? []))) chips.push({ label: `+${cap}`, className: ORANGE })
  const runtimes = new Set(analyzed.filter(p => !p.security!.sandboxed && p.security!.runtimeClassName).map(p => p.security!.runtimeClassName!))
  for (const r of runtimes) chips.push({ label: r, className: MUTED, title: "RuntimeClass" })
  return chips
}

// Scheduling priority by value: system classes red, platform yellow,
// ordinary positive green, default and below grey.
export function priorityClassName(value: number | undefined): string {
  if (value === undefined) return MUTED
  if (value >= 1_000_000_000) return RED
  if (value >= 10_000_000) return YELLOW
  if (value > 0) return OK
  return MUTED
}
