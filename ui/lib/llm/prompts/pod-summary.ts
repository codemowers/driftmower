import type { LiveFacts, StaticFacts } from "@/lib/features/pod-summary/types"
import { streamQuery } from "../query"

export const PROMPT_VERSION = 5

function renderStaticPrompt(facts: StaticFacts): string {
  const lines = facts.images.map(img => {
    const parts = [img.repo, `run=${img.runTag ?? "?"}`, `latest=${img.latestTag ?? "?"}`, `drift=${img.drift}`]
    if (img.builtAgeDays !== null) parts.push(`builtAge=${img.builtAgeDays}d`)
    if (img.eol !== "ok") parts.push(`eol=${img.eol}`)
    if (img.cve) {
      parts.push(`cve=CRIT${img.cve.critical}/HIGH${img.cve.high}`)
      if (img.cve.worst) {
        const w = img.cve.worst
        parts.push(`worst=${w.id}(score=${w.score} sev=${w.severity})`)
      }
    } else if (!img.scanned) {
      parts.push("cve=unscanned")
    }
    return `- ${parts.join(" ")}`
  })
  return [
    lines.length > 0 ? "images:" : "images: none (no container data in this report)",
    ...lines,
    `verdict: risk=${facts.riskDriver} fixAvailable=${facts.fixAvailable ? "yes" : "no"} confidence=${facts.confidence}`,
  ].join("\n")
}

function renderLivePrompt(facts: LiveFacts): string {
  const { pod, net, staticRisk } = facts
  const listening = net.listening.map(l => `${l.port}/${l.protocol}`).join(",") || "none"
  const outbound = net.outboundWorkloads.join(", ") || "none"
  const extIn = net.externalInboundPeers.join(", ") || "none"
  const lines = [
    `pod=${pod.name} ns=${pod.namespace} node=${pod.node ?? "?"} phase=${pod.phase}`,
    `listening=${listening}`,
    `inbound: external=${net.inbound.external} (${extIn}) internal=${net.inbound.internal}`,
    `outbound: ${net.outboundCount} peers [${outbound}] externalEndpoints=${net.externalEndpoints}`,
  ]
  if (net.hidden > 0) lines.push(`note=${net.hidden} connections not shown`)
  if (staticRisk) lines.push(`verdict: risk=${staticRisk.riskDriver} worstSeverity=${staticRisk.worstSeverity ?? "none"}`)
  return lines.join("\n")
}

export function callPodStaticSummaryPrompt(facts: StaticFacts) {
  return streamQuery({
    model: "qwen3.6-fast",
    systemPrompt: `You write a one-glance upgrade verdict for a Kubernetes pod's container images,
      for a platform engineer.

      RULES
      - Output 1-2 sentences, max ~45 words, plain prose. No lists, no markdown.
      - Say the action and how urgent it is: can the risk be cleared, with what size of
        upgrade, and is that upgrade safe.
      - Recommend clearing the real risk: use the given riskDriver, the drift class, and
        whether a fix is available. Never compute, invent, or state exact version numbers
        or CVE ids.
      - Version drift is the core signal: always state the overall drift (worst class and
        how many images are behind), even when a CVE leads. Don't dump exact version
        numbers.
      - Mention other signals only if abnormal: EOL only if past or imminent, build age
        only if very old. Don't state things that are fine.
      - If no image data is given, say only that drift and vulnerabilities can't be
        assessed for this pod. Never call a pod with no data healthy or up to date.
      - You may use general knowledge of well-known images (inferred from the repo name)
        to flag operational upgrade risk, e.g. a CNI, database, or ingress controller
        needing a maintenance window.
      - If a CVE has no fix version, say it cannot be patched out yet.
      - If confidence is low, briefly say the read is limited and why (e.g. image not
        scanned, no semver tag).
      - Terse, calm, sentence case. Refer to the image generically; do not name a
        specific pod.`,
    userPrompt: renderStaticPrompt(facts),
  })
}

export function callPodLiveSummaryPrompt(facts: LiveFacts) {
  return streamQuery({
    model: "qwen3.6-fast",
    systemPrompt: `You write a one-sentence runtime note for a specific Kubernetes pod, appended
      after an upgrade verdict, for a platform engineer.

      RULES
      - One sentence, max ~30 words, plain prose. No lists, no markdown.
      - You are appended after the upgrade verdict; add only the exposure and dependency
        angle and how it shifts the urgency of the given risk. Don't restate the drift or
        CVE details.
      - Exposure has two sides: inbound (who can reach this pod's listening services) and
        outbound (what it connects to). Weigh both.
      - Do not call the pod internal-only if it reaches any external endpoint; it
        egresses.
      - Many outbound peers or external egress means client-side exploits and blast
        radius still apply; say so rather than downplaying the risk.
      - Be conservative about lowering urgency: only call exposure low when both inbound
        and outbound are limited. The CVE's exploitation vector is unknown, so never call
        it less urgent from zero inbound alone.
      - Name the pod by its given name. Use only the given facts; never invent ports or
        peers.
      - Terse, calm, sentence case.`,
    userPrompt: renderLivePrompt(facts),
  })
}
