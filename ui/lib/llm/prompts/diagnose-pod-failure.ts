import type { DiagnosisPayload } from "@/lib/features/pod-diagnosis/payload"
import { DIAGNOSIS_CATEGORIES, FIX_KINDS, type DiagnosisCategory, type FixKind } from "@/lib/features/pod-diagnosis/types"
import type { FixSlots } from "@/lib/features/pod-diagnosis/commands"
import { query } from "../query"

export type DiagnosisAnswer = {
  category: DiagnosisCategory
  cause: string
  confidence: "high" | "medium" | "low"
  confidenceNote: string
  evidence: string[]
  fix: { kind: FixKind; action: string } & FixSlots
}

function block(title: string, lines: string[], prefix: string): string[] {
  if (lines.length === 0) return []
  return [`${title}:`, ...lines.map((line, i) => `${prefix}${i} ${line}`)]
}

export function renderUserPrompt(payload: DiagnosisPayload): string {
  const lines: string[] = ["pod:", ...payload.pod.map(line => `  ${line}`)]

  lines.push("", ...block("status", payload.status, "ST"))
  lines.push("", ...block("spec", payload.spec, "S"))

  lines.push("")
  if (payload.events.length === 0) lines.push("events: none (events expire after 1h)")
  else lines.push(...block("events", payload.events, "E"))

  payload.logs.forEach((logBlock, index) => {
    lines.push("", `logs container ${logBlock.container}, ${logBlock.run}:`)
    logBlock.lines.forEach((line, i) => lines.push(`L${index}.${i} ${line}`))
  })

  lines.push("", ...block("node", payload.node, "N"))
  lines.push("", ...block("siblings", payload.siblings, "SB"))
  lines.push("", ...block("other unhealthy pods in this namespace, which may or may not be connected to this one", payload.release, "R"))
  lines.push("", ...block("metrics", payload.metrics, "M"))

  return lines.filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n").trim()
}

const SLOT_NAMES = ["ref", "refKind", "resource", "suggested", "image", "service", "path"] as const

function text(value: unknown): string | null {
  if (typeof value === "number") return String(value)
  if (typeof value === "string" && value.trim()) return value.trim()
  return null
}

export function parseDiagnosisAnswer(raw: string): DiagnosisAnswer {
  const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Record<string, unknown>
  const fix = (typeof json.fix === "object" && json.fix !== null ? json.fix : {}) as Record<string, unknown>
  const category = DIAGNOSIS_CATEGORIES.find(c => c === text(json.category))
  const kind = FIX_KINDS.find(k => k === text(fix.kind))
  if (!category) throw new Error(`unknown category ${JSON.stringify(json.category)}`)
  if (!kind) throw new Error(`unknown fix kind ${JSON.stringify(fix.kind)}`)
  const action = text(json.action)
  if (!action) throw new Error(`empty action for ${category} with fix ${kind}`)

  const confidence = text(json.confidence)?.toLowerCase()
  const slots = Object.fromEntries(SLOT_NAMES.map(name => [name, text(fix[name])])) as Record<(typeof SLOT_NAMES)[number], string | null>
  return {
    category,
    cause: text(json.cause) ?? "",
    confidence: confidence === "high" || confidence === "low" ? confidence : "medium",
    confidenceNote: text(json.confidenceNote) ?? "no caveats",
    evidence: Array.isArray(json.evidence) ? json.evidence.map(text).filter((e): e is string => e !== null) : [],
    fix: { kind, action, ...slots },
  }
}

export async function callDiagnosePrompt(payload: DiagnosisPayload, abortSignal: AbortSignal): Promise<DiagnosisAnswer> {
  const raw = await query({
    model: "qwen3.6-diagnose",
    systemPrompt: `You diagnose one broken Kubernetes pod for the engineer who owns it. You get facts
      collected from the cluster, each line labelled with an index you can quote.

      Answer with one JSON object on one line and nothing else:
      {"category":"...","cause":"...","action":"...","confidence":"high|medium|low",
       "confidenceNote":"...","evidence":["L1.3-L1.5","ST0","E2"],"fix":{...}}

      category is one of: ${DIAGNOSIS_CATEGORIES.join(", ")}.
      cause is at most 25 words, one plain sentence saying what is wrong.
      action is at most 30 words, one sentence telling the engineer what to do next.
      confidenceNote is at most 10 words, or "no caveats".

      fix is exactly one of these shapes, with only the keys shown, every value copied from
        the facts:
        {"kind":"config","ref":"<Secret or ConfigMap name>","refKind":"Secret|ConfigMap"}
        {"kind":"resources","resource":"memory|cpu|ephemeral-storage","suggested":"<new value>"}
        {"kind":"image","image":"<image reference>","ref":"<pull secret name, or null when none is referenced>"}
        {"kind":"dependency","service":"<label at the start of its R line, or its exact pod name>"}
        {"kind":"spec","path":"<dotted path to the field in the pod template>","suggested":"<new value>"}
        {"kind":"volume","ref":"<claim name>"}
        {"kind":"rbac","ref":"<ServiceAccount name>"}
        {"kind":"namespace","ref":"<namespace name>"}
        {"kind":"placement"}  {"kind":"cleanup"}  {"kind":"manager"}  {"kind":"node"}  {"kind":"none"}
      Choose spec only when the facts show the field's current value and you name a different
        one. If the field already holds the value you would set, or the facts do not show the
        value, the spec is not the problem: use none and say in action what to investigate.
      When more than one kind fits, take the one whose keys you can fill: placement rather
        than none when no node satisfies the nodeSelector, affinity or tolerations, resources
        rather than spec for requests or limits.
      Choose volume when a PersistentVolumeClaim is unbound or a mount fails, rbac when the
        API server denies the ServiceAccount.
      Choose namespace when the facts say a namespace does not exist. This is the only fix
        kind for a missing namespace.
      If the pod you want to blame has no R line, use dependency with service null and name
        it in cause and action instead.
      cleanup means deleting pods that are already dead and nothing else. A stale file or
        lock inside a volume is manager or none.

      RULES
      - Quote evidence from status ST, spec S, events E, logs L, node N, siblings SB, related
        pods R and metrics M.
      - Use only the given facts. Never invent names, versions, paths or numbers. Quote at
        most 4 indices and at most 5 log lines in one range.
      - cause and fix must blame the same thing. When several dependencies are failing,
        blame one of them in cause and give that same one as service.
      - Metrics are point samples and are unavailable for dead pods. Say so in
        confidenceNote when they carry the verdict.
      - Eviction: compare the eviction time with the node state now. Pressure gone and
        healthy siblings elsewhere means leftovers to clean up, not an ongoing incident. Use
        category evicted and fix cleanup.
      - Healthy siblings on other nodes point at the node or the data, not at the image.
      - Never blame another pod unless this pod's own logs name it or its address. Pods
        listed under R are merely unhealthy neighbours; being broken at the same time is not
        a connection.
      - When related pods are failing and this pod's logs point at one of them (connection
        refused, no route to host, unavailable, timeout, on its address or port), this pod
        is a victim: category dependency, fix dependency, service set to that failing pod.
        Do not diagnose the dependency itself here.
      - A container that exits 0 and is restarted while a liveness probe is configured is
        being killed by that probe: category probe.
      - For a probe failure, compare the port and address the probe dials in the event with
        the container's ports line in the spec and any log line saying where the app
        listens. A different port is a spec fix on the probe port. An app listening on IPv4
        only while the probe dials an IPv6 address is the app binding to the wrong
        interface: use none and say in action that it must listen on all interfaces. A probe
        timeout while cpu usage sits at its limit is resources. Do not claim an address
        problem without a log line stating the listening address. Never edit httpGet.host;
        the probe runs from the node, not the pod.
      - CreateContainerConfigError with a missing Secret or ConfigMap: category config, fix
        config, ref taken from the message.
      - fix config needs the exact Secret or ConfigMap name in ref. If the thing that is
        missing is not a Secret or ConfigMap, config is the wrong fix kind.
      - An image pull that fails with 401 or unauthorized is a credentials problem, not a
        missing image. Use fix image and say which pull secret is referenced, or that none
        is.
      - When the pod is owned by a Job or a chart install and the same failure repeats on
        every run, the fix belongs to whatever manages it: use fix manager.
      - Blame memory only when the facts say OOMKilled. Exit code 137 on its own is an
        external kill, not memory.
      - Confidence: high when a line you quoted states the failure outright and the fix
        follows from it; medium when you infer the cause from indirect signs or the value you
        suggest is a judgment; low when the facts are too thin. Name the gap in
        confidenceNote whenever you are not high.
      - Keep cause to something the engineer can verify with kubectl in one minute.`,
    userPrompt: renderUserPrompt(payload),
    abortSignal,
  })
  return parseDiagnosisAnswer(raw)
}
