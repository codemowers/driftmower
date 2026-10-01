"use client"

import { cn } from "@/lib/utils/cn"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import { useContextHref } from "@/lib/hooks/use-context-href"
import { useSeesClusterWideViews } from "@/lib/tenancy/sandbox-context"
import { useTabParam } from "@/lib/hooks/use-tab-param"
import CopyButton from "@/app/components/copy-button"
import { StatCell, StatValue } from "@/app/components/stats-card"
import type { DiagnosisCategory, DiagnosisFacts, Evidence } from "@/lib/features/pod-diagnosis/types"
import { usePodDiagnosis } from "../hooks/use-pod-diagnosis"
import { POD_TABS, POD_TABS_ID } from "./pod-tabs"
import PrefetchLink from "@/app/components/prefetch-link"

const CATEGORY_LABEL: Record<DiagnosisCategory, string> = {
  crash: "Crash loop",
  oom: "Out of memory",
  probe: "Probe kill",
  evicted: "Evicted",
  config: "Missing config",
  "image-pull": "Image pull",
  unschedulable: "Unschedulable",
  node: "Node",
  dependency: "Dependency down",
  volume: "Volume",
  rbac: "Permissions",
}

const MAJOR_CATEGORIES = new Set<DiagnosisCategory>(["crash", "oom", "evicted", "node", "volume"])

const CONFIDENCE_DOTS = { high: 3, medium: 2, low: 1 } as const

const DENSE_CELL = "px-6 py-3.5"
const DENSE_VALUE = "text-[17px]"
const ROW_LABEL = "w-[92px] shrink-0 text-xs font-semibold"

function categoryEdge(category: DiagnosisCategory): string {
  return MAJOR_CATEGORIES.has(category) ? "border-t-status-major" : "border-t-status-patch"
}

function pendingLabel(pod: ClusterResource): string {
  const display = pod.podStatus?.display ?? pod.phase ?? "Unknown"
  if (display === "Evicted") return "Evicted"
  if (display === "CrashLoopBackOff") return "Crash loop"
  if (display.includes("ImagePull") || display.includes("ErrImagePull")) return "Image pull"
  if (display.includes("ConfigError")) return "Missing config"
  return display
}

function sinceLabel(since: string | null): string {
  if (!since) return "—"
  const ms = Date.now() - Date.parse(since)
  if (!Number.isFinite(ms)) return "—"
  const minutes = Math.max(1, Math.round(ms / 60000))
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"}`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? "day" : "days"}`
}

function failingContainerOf(facts: DiagnosisFacts) {
  const containers = facts.podStatus.containers
  return containers.find(c => c.lastTerminated) ?? containers.find(c => c.waiting) ?? containers[0] ?? null
}

type Caption = { text: string; mono: boolean }

function causeCaption(facts: DiagnosisFacts): Caption {
  const container = failingContainerOf(facts)
  const parts: string[] = []
  const exitCode = container?.lastTerminated?.exitCode
  if (typeof exitCode === "number") parts.push(`exit ${exitCode}`)
  else if (container?.waiting?.reason) parts.push(container.waiting.reason)
  if (facts.podStatus.restarts > 0) parts.push("every run")
  return parts.length > 0 ? { text: parts.join(" · "), mono: true } : { text: facts.podStatus.display, mono: true }
}

function clockOf(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null
}

function sinceCaption(facts: DiagnosisFacts): Caption {
  const lastRestart = clockOf(failingContainerOf(facts)?.lastTerminated?.finishedAt)
  const restarts = facts.podStatus.restarts
  const ageMs = facts.createdAt ? Date.now() - Date.parse(facts.createdAt) : NaN
  const hours = Number.isFinite(ageMs) ? ageMs / 3600000 : 0
  const rate = restarts > 0 && hours >= 1 ? `~${Math.max(1, Math.round(restarts / hours))}/h` : null
  const parts = [lastRestart ? `last restart ${lastRestart}` : null, rate].filter(Boolean)
  return parts.length > 0 ? { text: parts.join(" · "), mono: true } : { text: "since the first warning or pod start", mono: false }
}

function affectsLabel(facts: DiagnosisFacts): string {
  const failing = Math.max(1, facts.duplicates)
  return failing > 1 ? `${failing} of ${Math.max(failing, facts.siblings.total)} pods` : "Only this pod"
}

function affectsCaption(facts: DiagnosisFacts): Caption {
  if (Math.max(1, facts.duplicates) === 1 && facts.ownerKind && facts.ownerName) {
    return { text: `${facts.ownerKind} ${facts.ownerName}`, mono: true }
  }
  return { text: "failing the same way", mono: false }
}

function splitTimestamp(line: string): { stamp: string | null; text: string } {
  const match = /^(\S*\d{2}:\d{2}:\d{2}\S*)\s+(.*)$/.exec(line)
  if (!match) return { stamp: null, text: line }
  const clock = /(\d{2}:\d{2}:\d{2})/.exec(match[1])
  return { stamp: clock ? clock[1] : match[1], text: match[2] }
}

type ParsedEvent = { reason: string; meta: string; text: string }

function parseEvent(line: string): ParsedEvent | null {
  const match = /^(Normal|Warning)\s+(\S+)\s+x(\d+)(?:\s+last\s+(\S+))?:\s*([\s\S]*)$/.exec(line)
  if (!match) return null
  const [, , reason, count, last, text] = match
  const meta = [Number(count) > 1 ? `x${count}` : null, clockOf(last)].filter(Boolean).join(" · ")
  return { reason, meta, text }
}

function groupEvidence(evidence: Evidence[]): { label: string; link: Evidence["link"]; kind: Evidence["kind"]; lines: string[] }[] {
  const groups: { label: string; link: Evidence["link"]; kind: Evidence["kind"]; lines: string[] }[] = []
  for (const item of evidence) {
    const last = groups[groups.length - 1]
    if (last && last.label === item.label && last.kind === item.kind) last.lines.push(item.text)
    else groups.push({ label: item.label, link: item.link, kind: item.kind, lines: [item.text] })
  }
  return groups
}

const LINK_LABEL: Record<string, string> = { logs: "logs", yaml: "yaml", node: "node", pods: "pods" }

function Dots({ level }: { level: keyof typeof CONFIDENCE_DOTS }) {
  const filled = CONFIDENCE_DOTS[level]
  return (
    <span className="flex items-center gap-1">
      {[0, 1, 2].map(i => (
        <span key={i} className={cn("size-2 rounded-full", i < filled ? "bg-brand" : "bg-gray-200")} />
      ))}
    </span>
  )
}

function StatCaption({ caption }: { caption: Caption }) {
  return <p className={cn("text-xs text-muted-foreground", caption.mono && "font-mono")}>{caption.text}</p>
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-gray-200 px-5 py-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      {children}
    </section>
  )
}

const EVIDENCE_LINK = "shrink-0 font-mono text-xs text-muted-foreground hover:text-brand hover:underline"
const MONO_EVIDENCE = new Set<Evidence["kind"]>(["logs", "spec"])

function EvidenceLine({ kind, line }: { kind: Evidence["kind"]; line: string }) {
  if (MONO_EVIDENCE.has(kind)) {
    const { stamp, text } = kind === "logs" ? splitTimestamp(line) : { stamp: null, text: line }
    return (
      <code className="whitespace-pre-wrap break-words font-mono text-[12.5px] text-foreground">
        {stamp && <span className="mr-2 text-muted-foreground">{stamp}</span>}
        {text}
      </code>
    )
  }
  const event = kind === "event" ? parseEvent(line) : null
  if (event) {
    return (
      <span className="text-[13px] leading-snug text-foreground">
        <span className="font-semibold">{event.reason}</span>
        {event.meta && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{event.meta}</span>}
        <span className="ml-1.5">{event.text}</span>
      </span>
    )
  }
  return <span className="text-[13px] leading-snug text-foreground">{line}</span>
}

function EvidenceGroup({
  group,
  hrefFor,
  onLogsClick,
}: {
  group: { label: string; link: Evidence["link"]; kind: Evidence["kind"]; lines: string[] }
  hrefFor: (link: Evidence["link"]) => string | null
  onLogsClick: (event: React.MouseEvent<HTMLAnchorElement>) => void
}) {
  const href = hrefFor(group.link)
  return (
    <div className="flex items-baseline gap-4 px-4 py-3">
      <span className={cn(ROW_LABEL, "text-foreground")}>{group.label}</span>
      <div className="min-w-0 flex-1">
        {group.lines.length === 1 ? (
          <EvidenceLine kind={group.kind} line={group.lines[0]} />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {group.lines.map(line => (
              <li key={line} className="grid grid-cols-[8px_minmax(0,1fr)] items-start gap-2">
                <span aria-hidden className="mt-[7px] size-1 rounded-full bg-gray-400" />
                <EvidenceLine kind={group.kind} line={line} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {href && group.link === "yaml" && (
        <a href={href} target="_blank" rel="noreferrer" className={EVIDENCE_LINK}>
          {LINK_LABEL[group.link]} ↗
        </a>
      )}
      {href && group.link && group.link !== "yaml" && (
        <PrefetchLink href={href} onClick={group.link === "logs" ? onLogsClick : undefined} className={EVIDENCE_LINK}>
          {LINK_LABEL[group.link]} ↗
        </PrefetchLink>
      )}
    </div>
  )
}

export default function DiagnosisCard({ pod, workloadUid }: { pod: ClusterResource; workloadUid: string }) {
  const { facts, state, unavailable, error, rechecking, recheck } = usePodDiagnosis(pod)
  const { linkTo } = useContextHref()
  const seesClusterWideViews = useSeesClusterWideViews()
  const [, setPodTab] = useTabParam("ptab", POD_TABS)

  if (!facts) return null

  const result = state?.result ?? null
  const pending = !state || state.state === "pending"
  const awaitingFirst = pending && !result
  const category = result?.category ?? null

  function hrefFor(link: Evidence["link"]): string | null {
    if (link === "logs") return linkTo(`/topmost-owners/${workloadUid}/${pod.uid}`, { set: { ptab: "logs" } })
    if (link === "pods") return linkTo(`/topmost-owners/${workloadUid}`)
    // The Cluster page is hidden from sandbox users, so do not offer the link.
    if (link === "node") return seesClusterWideViews ? linkTo("/cluster") : null
    if (link === "yaml") return linkTo(`/yaml/${pod.uid}`, { drop: ["ptab", "wtab", "htab"] })
    return null
  }

  function openLogsTab(event: React.MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
    event.preventDefault()
    setPodTab("Logs")
    document.getElementById(POD_TABS_ID)?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className="mt-2">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Diagnosis</p>
        <span className="rounded-md bg-brand-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-label">AI</span>
      </div>

      <div className={cn("overflow-hidden rounded-xl border border-gray-200 border-t-4 bg-white", categoryEdge(category ?? "crash"))}>
        <div className="grid grid-cols-4 divide-x divide-gray-200">
          <StatCell label="Cause" className={DENSE_CELL}>
            <StatValue className={DENSE_VALUE}>{category ? CATEGORY_LABEL[category] : pendingLabel(pod)}</StatValue>
            <StatCaption caption={causeCaption(facts)} />
          </StatCell>
          <StatCell label="Since" className={DENSE_CELL}>
            <StatValue className={DENSE_VALUE}>{sinceLabel(result?.since ?? facts.createdAt)}</StatValue>
            <StatCaption caption={sinceCaption(facts)} />
          </StatCell>
          <StatCell label="Affects" className={DENSE_CELL}>
            <StatValue className={DENSE_VALUE}>{affectsLabel(facts)}</StatValue>
            <StatCaption caption={affectsCaption(facts)} />
          </StatCell>
          <StatCell label="Confidence" className={DENSE_CELL}>
            {result && !pending ? (
              <StatValue className={cn(DENSE_VALUE, "flex items-center gap-2")}>
                <span className="capitalize">{result.confidence}</span>
                <Dots level={result.confidence} />
              </StatValue>
            ) : (
              <StatValue className={DENSE_VALUE}>—</StatValue>
            )}
            <StatCaption caption={{ text: result && !pending ? result.confidenceNote : "waiting for the model", mono: false }} />
          </StatCell>
        </div>

        <Section title={awaitingFirst && !unavailable ? "Assessing" : "What happened"}>
          {unavailable ? (
            <p className="text-sm text-muted-foreground">AI diagnosis is off ({unavailable}). The status and evidence above still come from the cluster.</p>
          ) : awaitingFirst ? (
            <p className="text-sm text-muted-foreground">
              {error ? `Can't reach the diagnosis service, retrying: ${error}` : "Reading logs, events and node state. This usually takes a few minutes."}
            </p>
          ) : (
            <p className="text-[15px] font-semibold text-foreground">{result?.cause}</p>
          )}
        </Section>

        {result && result.evidence.length > 0 && (
          <Section title="Evidence">
            <div className="divide-y divide-gray-200 rounded-lg border border-gray-200">
              {groupEvidence(result.evidence).map(group => (
                <EvidenceGroup key={`${group.kind}-${group.lines[0]}`} group={group} hrefFor={hrefFor} onLogsClick={openLogsTab} />
              ))}
            </div>
          </Section>
        )}

        {result && (result.fix.kind !== "none" || result.check) && (
          <Section title="How to fix">
            <div className="divide-y divide-gray-200 rounded-lg border border-gray-200">
              {result.fix.action && <p className="px-4 py-3 text-sm text-foreground">{result.fix.action}</p>}
              {result.fix.commands.length > 0 && (
                <div className="flex flex-col gap-2 px-4 py-3">
                  {result.fix.commands.map(command => (
                    <div key={command.value} className="flex items-center gap-3 rounded-lg bg-gray-100 px-3 py-2">
                      <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{command.label}</span>
                      <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[12.5px] text-foreground">{command.value}</code>
                      <CopyButton value={command.value} className="shrink-0" />
                    </div>
                  ))}
                </div>
              )}
              {result.check && (
                <div className="flex items-baseline gap-4 px-4 py-3">
                  <span className={cn(ROW_LABEL, "text-foreground")}>Done when</span>
                  <p className="min-w-0 flex-1 text-[13px] leading-snug text-foreground">{result.check}</p>
                </div>
              )}
            </div>
          </Section>
        )}

        <div className="flex items-center justify-between gap-4 border-t border-gray-200 px-5 py-2.5">
          <span className="text-[11.5px] text-muted-foreground">
            {rechecking
              ? "Re-checking this pod, this may take some time."
              : state && state.state !== "pending" && state.computedAt
                ? `Assessed ${new Date(state.computedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                : "Not assessed yet"}
          </span>
          {!pending && !rechecking && (
            <button
              type="button"
              onClick={recheck}
              className="text-xs text-muted-foreground hover:text-brand-label hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              Re-check
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
