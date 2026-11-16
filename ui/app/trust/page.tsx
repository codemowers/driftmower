"use client"

import MarkdownText from "@/app/components/markdown-text"

import { Fragment, useEffect, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import PageHeader from "../components/page-header"
import { FilterSearchInput } from "../components/filter-bar"
import LoadingLine from "@/app/components/loading-line"
import LoadError from "@/app/components/load-error"
import { Switch } from "@/components/ui/switch"
import { callTool } from "@/browser/connection"
import { cn } from "@/lib/utils/cn"

type Severity = "critical" | "warning" | "info"
type Finding = { severity: Severity; code: string; message: string }
type NameConstraints = {
  critical: boolean
  permittedDNS?: string[]
  excludedDNS?: string[]
  permittedIPRanges?: string[]
  excludedIPRanges?: string[]
  permittedEmail?: string[]
  excludedEmail?: string[]
  permittedURIDomains?: string[]
  excludedURIDomains?: string[]
}
type Certificate = {
  subject: string
  issuer: string
  serial: string
  serialBits: number
  version: number
  notBefore: string
  notAfter: string
  sha256: string
  publicKey: string
  signatureAlgorithm: string
  isCA: boolean
  maxPathLen?: number
  keyUsage: string[]
  extKeyUsage?: string[]
  subjectKeyId?: string
  authorityKeyId?: string
  nameConstraints?: NameConstraints
  selfSigned: boolean
  expired: boolean
  notYetValid: boolean
  findings: Finding[]
}
type Source = { kind: "configMap" | "secret" | "inLine" | "defaultCAs"; name?: string; key?: string }
type Mount = { policy: string; description?: string }
type Bundle = {
  name: string
  configMapKey?: string
  secretKey?: string
  synced: boolean
  reason?: string
  sources: Source[]
  namespace?: string
  certificates: Certificate[]
  mountedBy: Mount[]
}
type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; bundles: Bundle[]; warnings: string[] }

const EXPIRING_DAYS = 90
const DAY = 24 * 60 * 60 * 1000

function commonName(dn: string): string {
  const part = dn.split(",").find(p => p.startsWith("CN=")) ?? dn.split(",").find(p => p.startsWith("OU=")) ?? dn
  return part.replace(/^(CN|OU)=/, "")
}

function organization(dn: string): string {
  return dn.split(",").find(p => p.startsWith("O="))?.slice(2) ?? ""
}

type Validity = "expired" | "expiring" | "pending" | "valid"

function validity(c: Certificate, now: number): Validity {
  if (c.expired) return "expired"
  if (c.notYetValid) return "pending"
  if (new Date(c.notAfter).getTime() - now < EXPIRING_DAYS * DAY) return "expiring"
  return "valid"
}

const VALIDITY_ORDER: Record<Validity, number> = { expired: 0, expiring: 1, pending: 2, valid: 3 }
const VALIDITY_STYLE: Record<Validity, string> = {
  expired: "bg-status-major-bg text-status-major-text",
  expiring: "bg-status-minor-bg text-status-minor-text",
  pending: "bg-status-minor-bg text-status-minor-text",
  valid: "bg-status-ok-bg text-status-ok-text",
}
const VALIDITY_LABEL: Record<Validity, string> = {
  expired: "Expired",
  expiring: `Expires within ${EXPIRING_DAYS} days`,
  pending: "Not yet valid",
  valid: "Valid",
}
const SEVERITY_STYLE: Record<Severity, string> = {
  critical: "bg-status-major-bg text-status-major-text",
  warning: "bg-status-minor-bg text-status-minor-text",
  info: "bg-muted text-muted-foreground",
}

function count(findings: Finding[], severity: Severity): number {
  return findings.filter(f => f.severity === severity).length
}

// Findings that deserve attention; expiry is shown by the status column.
function problematic(c: Certificate, v: Validity): boolean {
  return v !== "valid" || c.findings.some(f => f.severity !== "info")
}

function describeSource(s: Source): string {
  switch (s.kind) {
    case "defaultCAs": return "trust-manager default public CAs"
    case "inLine": return "Inline PEM"
    default: return `${s.kind === "secret" ? "Secret" : "ConfigMap"} ${s.name}${s.key ? ` (key ${s.key})` : ""}`
  }
}

function matches(c: Certificate, query: string): boolean {
  return !query || [c.subject, c.issuer, c.sha256, c.serial, c.publicKey, ...c.findings.map(f => f.code)].join(" ").toLowerCase().includes(query)
}

function SeverityBadges({ findings }: { findings: Finding[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {(["critical", "warning", "info"] as const).map(s => {
        const n = count(findings, s)
        return n > 0 ? <span key={s} className={cn("whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium", SEVERITY_STYLE[s])}>{n} {s}</span> : null
      })}
    </div>
  )
}

function ConstraintList({ label, values }: { label: string; values?: string[] }) {
  if (!values?.length) return null
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs leading-5">{values.join(", ")}</dd>
    </>
  )
}

function CertificateDetails({ c }: { c: Certificate }) {
  const nc = c.nameConstraints
  return (
    <div className="flex flex-col gap-4 py-3">
      {c.findings.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {c.findings.map(f => (
            <li key={f.code} className="flex gap-2 text-sm">
              <span className={cn("h-fit shrink-0 rounded px-1.5 py-0.5 text-xs font-medium", SEVERITY_STYLE[f.severity])}>{f.severity}</span>
              <span><span className="font-mono text-xs">{f.code}</span> — {f.message}</span>
            </li>
          ))}
        </ul>
      )}
      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">Subject</dt><dd className="break-all font-mono text-xs leading-5">{c.subject}</dd>
        <dt className="text-muted-foreground">Issuer</dt><dd className="break-all font-mono text-xs leading-5">{c.selfSigned ? "Self-signed" : c.issuer}</dd>
        <dt className="text-muted-foreground">Public key</dt><dd>{c.publicKey}</dd>
        <dt className="text-muted-foreground">Signature</dt><dd>{c.signatureAlgorithm}</dd>
        <dt className="text-muted-foreground">Serial</dt><dd className="break-all font-mono text-xs leading-5">{c.serial} <span className="font-sans text-muted-foreground">({c.serialBits} bits)</span></dd>
        <dt className="text-muted-foreground">Validity</dt><dd className="tabular-nums">{c.notBefore.slice(0, 10)} → {c.notAfter.slice(0, 10)}</dd>
        <dt className="text-muted-foreground">Basic constraints</dt>
        <dd>{c.isCA ? `CA${c.maxPathLen !== undefined ? `, path length ≤ ${c.maxPathLen}` : ", unlimited path length"}` : "Not a CA"}</dd>
        <dt className="text-muted-foreground">Key usage</dt><dd>{c.keyUsage.length ? c.keyUsage.join(", ") : "—"}</dd>
        {c.extKeyUsage?.length ? <><dt className="text-muted-foreground">Extended key usage</dt><dd>{c.extKeyUsage.join(", ")}</dd></> : null}
        <dt className="text-muted-foreground">Version</dt><dd>X.509 v{c.version}</dd>
        {c.subjectKeyId && <><dt className="text-muted-foreground">Subject key ID</dt><dd className="break-all font-mono text-xs leading-5">{c.subjectKeyId}</dd></>}
        {c.authorityKeyId && <><dt className="text-muted-foreground">Authority key ID</dt><dd className="break-all font-mono text-xs leading-5">{c.authorityKeyId}</dd></>}
        <dt className="text-muted-foreground">SHA-256</dt><dd className="break-all font-mono text-xs leading-5">{c.sha256}</dd>
      </dl>
      {nc && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Name constraints{nc.critical ? " (critical)" : ""}</h4>
          <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-[max-content_1fr]">
            <ConstraintList label="Permitted DNS" values={nc.permittedDNS} />
            <ConstraintList label="Excluded DNS" values={nc.excludedDNS} />
            <ConstraintList label="Permitted IP ranges" values={nc.permittedIPRanges} />
            <ConstraintList label="Excluded IP ranges" values={nc.excludedIPRanges} />
            <ConstraintList label="Permitted email" values={nc.permittedEmail} />
            <ConstraintList label="Excluded email" values={nc.excludedEmail} />
            <ConstraintList label="Permitted URI domains" values={nc.permittedURIDomains} />
            <ConstraintList label="Excluded URI domains" values={nc.excludedURIDomains} />
          </dl>
        </div>
      )}
    </div>
  )
}

function BundleSection({ bundle, query, problemsOnly, now }: { bundle: Bundle; query: string; problemsOnly: boolean; now: number }) {
  const [open, setOpen] = useState<string | null>(null)
  const certificates = bundle.certificates
    .map(c => ({ c, v: validity(c, now) }))
    .filter(({ c, v }) => matches(c, query) && (!problemsOnly || problematic(c, v)))
    .sort((a, b) => VALIDITY_ORDER[a.v] - VALIDITY_ORDER[b.v] || a.c.notAfter.localeCompare(b.c.notAfter))
  const all = bundle.certificates.flatMap(c => c.findings)
  const constrained = bundle.certificates.filter(c => c.nameConstraints).length

  return (
    <section id={bundle.name} className="flex flex-col gap-4 rounded-lg border border-border p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-mono text-lg font-semibold">{bundle.name}</h2>
        <span className={cn("rounded px-2 py-0.5 text-xs font-medium", bundle.synced ? VALIDITY_STYLE.valid : VALIDITY_STYLE.expired)}>
          {bundle.synced ? "Synced" : `Not synced${bundle.reason ? `: ${bundle.reason}` : ""}`}
        </span>
        <span className="text-sm tabular-nums text-muted-foreground">
          {bundle.certificates.length} certificates{constrained > 0 && <> · {constrained} name-constrained</>}
        </span>
        <SeverityBadges findings={all} />
      </div>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">Sources</dt>
        <dd>{bundle.sources.length ? bundle.sources.map(describeSource).join(" · ") : "None"}</dd>
        <dt className="text-muted-foreground">Distributed as</dt>
        <dd className="font-mono text-xs leading-5">
          {[bundle.configMapKey && `ConfigMap ${bundle.name} key ${bundle.configMapKey}`, bundle.secretKey && `Secret ${bundle.name} key ${bundle.secretKey}`].filter(Boolean).join(" · ") || "—"}
        </dd>
        <dt className="text-muted-foreground">Mounted into Pods by</dt>
        <dd>
          {bundle.mountedBy.length === 0 ? (
            <span className="text-muted-foreground">No admission policy mounts this bundle; workloads must mount it themselves.</span>
          ) : (
            <ul className="flex flex-col gap-1">
              {bundle.mountedBy.map(m => (
                <li key={m.policy}>
                  {m.description ? (
                    <details>
                      <summary className="cursor-pointer font-mono text-xs leading-5">{m.policy}</summary>
                      <MarkdownText text={m.description} className="mt-1 max-w-prose text-muted-foreground" />
                    </details>
                  ) : <span className="font-mono text-xs">{m.policy}</span>}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>

      {bundle.certificates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {bundle.namespace ? `Not distributed to namespace ${bundle.namespace}, so its certificates cannot be shown.` : "Certificates are not available."}
        </p>
      ) : certificates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No certificates match.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-semibold">Certificate</th>
                <th className="py-2 pr-4 font-semibold">Key</th>
                <th className="py-2 pr-4 font-semibold">Status</th>
                <th className="py-2 pr-4 font-semibold">Valid until</th>
                <th className="py-2 font-semibold">Findings</th>
              </tr>
            </thead>
            <tbody>
              {certificates.map(({ c, v }) => {
                const expanded = open === c.sha256
                return (
                  <Fragment key={c.sha256}>
                    <tr
                      className="cursor-pointer border-t border-border align-top hover:bg-muted/40"
                      onClick={() => setOpen(expanded ? null : c.sha256)}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(expanded ? null : c.sha256) } }}
                      tabIndex={0}
                      aria-expanded={expanded}
                    >
                      <td className="py-2 pr-4">
                        <div className="flex items-start gap-1.5">
                          {expanded ? <ChevronDown className="mt-0.5 size-4 shrink-0" aria-hidden /> : <ChevronRight className="mt-0.5 size-4 shrink-0" aria-hidden />}
                          <div>
                            <div className="font-medium">{commonName(c.subject)}</div>
                            <div className="text-xs text-muted-foreground" title={c.subject}>
                              {organization(c.subject) || c.subject}
                              {!c.selfSigned && <> · issued by {commonName(c.issuer)}</>}
                              {c.nameConstraints && <> · name-constrained</>}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="whitespace-nowrap py-2 pr-4">{c.publicKey}</td>
                      <td className="py-2 pr-4">
                        <span className={cn("whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium", VALIDITY_STYLE[v])}>{VALIDITY_LABEL[v]}</span>
                      </td>
                      <td className="whitespace-nowrap py-2 pr-4 tabular-nums" title={`Valid from ${c.notBefore.slice(0, 10)}`}>{c.notAfter.slice(0, 10)}</td>
                      <td className="py-2"><SeverityBadges findings={c.findings} /></td>
                    </tr>
                    {expanded && (
                      <tr className="border-t border-dashed border-border">
                        <td colSpan={5} className="pl-6"><CertificateDetails c={c} /></td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default function TrustPage() {
  const [state, setState] = useState<State>({ status: "loading" })
  const [query, setQuery] = useState("")
  const [problemsOnly, setProblemsOnly] = useState(false)
  const [now] = useState(() => Date.now())
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    callTool<{ bundles: Bundle[]; warnings: string[] }>("list_trust_bundles")
      .then(r => { if (!cancelled) setState({ status: "ready", bundles: r.bundles, warnings: r.warnings }) })
      .catch((e: unknown) => { if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : String(e) }) })
    return () => { cancelled = true }
  }, [attempt])
  const retry = () => { setState({ status: "loading" }); setAttempt(a => a + 1) }

  return (
    <div className="min-h-full flex flex-col items-center">
      <main className="flex w-full flex-1 flex-col gap-8 px-7 py-12">
        <PageHeader
          title="Trust"
          subtitle="CA bundles distributed by trust-manager, the admission policies that mount them into workloads, and problems in each CA certificate"
        />

        {state.status === "loading" && <LoadingLine loading="trust bundles" />}
        {state.status === "error" && <LoadError message={`Failed to load trust bundles: ${state.message}`} onRetry={retry} />}

        {state.status === "ready" && (
          <>
            <div className="flex flex-wrap items-center gap-4">
              <FilterSearchInput value={query} onChange={setQuery} placeholder="Search subject, issuer, key, fingerprint or finding..." />
              <label className="flex shrink-0 cursor-pointer items-center gap-2.5 text-sm font-medium text-foreground">
                Problems only
                <Switch checked={problemsOnly} onCheckedChange={setProblemsOnly} />
              </label>
            </div>
            {state.warnings.map(w => <p key={w} className="text-sm text-muted-foreground">{w}</p>)}
            {state.bundles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No trust-manager Bundles were found in this cluster.</p>
            ) : (
              state.bundles.map(b => (
                <BundleSection key={b.name} bundle={b} query={query.trim().toLowerCase()} problemsOnly={problemsOnly} now={now} />
              ))
            )}
          </>
        )}
      </main>
    </div>
  )
}
