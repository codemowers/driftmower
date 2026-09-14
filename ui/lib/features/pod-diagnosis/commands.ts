import type { DiagnosisFacts, FixCommand, FixKind } from "./types"

export type FixSlots = {
  ref?: string | null
  refKind?: string | null
  resource?: string | null
  suggested?: string | null
  image?: string | null
  service?: string | null
  path?: string | null
}

function helmRelease(facts: DiagnosisFacts): { namespace: string; name: string } | null {
  return facts.manager.kind === "helm" && facts.manager.name && facts.manager.namespace
    ? { namespace: facts.manager.namespace, name: facts.manager.name }
    : null
}

function k3sChart(facts: DiagnosisFacts): string | null {
  return facts.manager.kind === "k3s-chart" ? facts.manager.name ?? null : null
}

function argoApp(facts: DiagnosisFacts): string | null {
  return facts.manager.kind === "argo" ? facts.manager.name ?? null : null
}

function workloadTarget(facts: DiagnosisFacts): string | null {
  if (!facts.topmostKind || !facts.topmostName) return null
  return `${facts.topmostKind.toLowerCase()}/${facts.topmostName}`
}

export function resolveService(service: string | null | undefined, facts: DiagnosisFacts): string | null {
  const given = service?.trim() ?? ""
  if (!given) return null
  const label = /^R(\d+)$/.exec(given)
  if (label) return facts.release[Number(label[1])]?.name ?? null
  return facts.release.some(pod => pod.name === given) ? given : null
}

export function commandsFor(kind: FixKind, slots: FixSlots, facts: DiagnosisFacts): FixCommand[] {
  const ns = facts.namespace
  const helm = helmRelease(facts)
  const argo = argoApp(facts)
  const chart = k3sChart(facts)
  const commands: FixCommand[] = []

  if (kind === "config") {
    const refKind = (slots.refKind ?? "Secret").toLowerCase() === "configmap" ? "configmap" : "secret"
    if (slots.ref) commands.push({ label: "kubectl", value: `kubectl -n ${ns} get ${refKind} ${slots.ref}` })
    if (helm) commands.push({ label: "helm", value: `helm -n ${helm.namespace} get values ${helm.name}` })
    if (argo) commands.push({ label: "argocd", value: `argocd app get ${argo}` })
  }

  if (kind === "resources") {
    const resource = slots.resource ?? "memory"
    const suggested = slots.suggested ?? ""
    const target = workloadTarget(facts)
    if (helm) commands.push({ label: "helm", value: `helm -n ${helm.namespace} get values ${helm.name}` })
    if (argo && suggested) commands.push({ label: "argocd", value: `argocd app set ${argo} -p resources.limits.${resource}=${suggested}` })
    if (!helm && !argo && target && suggested) commands.push({ label: "kubectl", value: `kubectl -n ${ns} set resources ${target} --limits=${resource}=${suggested}` })
  }

  if (kind === "image") {
    const pullSecretHint = slots.ref
    if (pullSecretHint) commands.push({ label: "kubectl", value: `kubectl -n ${ns} get secret ${pullSecretHint}` })
    if (slots.image) commands.push({ label: "kubectl", value: `crane manifest ${slots.image}` })
  }

  if (kind === "manager") {
    if (helm) commands.push({ label: "helm", value: `helm -n ${helm.namespace} history ${helm.name}` })
    else if (argo) commands.push({ label: "argocd", value: `argocd app get ${argo}` })
    else if (chart) commands.push({ label: "kubectl", value: `kubectl -n ${ns} edit helmchart ${chart}` })
    else if (facts.topmostKind && facts.topmostName) commands.push({ label: "kubectl", value: `kubectl -n ${ns} describe ${facts.topmostKind.toLowerCase()}/${facts.topmostName}` })
  }

  if (kind === "spec") {
    const target = workloadTarget(facts)
    if (helm) commands.push({ label: "helm", value: `helm -n ${helm.namespace} get values ${helm.name}` })
    else if (chart) commands.push({ label: "kubectl", value: `kubectl -n ${ns} edit helmchart ${chart}` })
    else if (argo) commands.push({ label: "argocd", value: `argocd app get ${argo}` })
    else if (target) commands.push({ label: "kubectl", value: `kubectl -n ${ns} edit ${target}` })
    if (slots.path) commands.push({ label: "path", value: `${slots.path}${slots.suggested ? ` = ${slots.suggested}` : ""}` })
  }

  if (kind === "namespace") {
    if (slots.ref) commands.push({ label: "kubectl", value: `kubectl create namespace ${slots.ref}` })
    if (helm) commands.push({ label: "helm", value: `helm -n ${helm.namespace} get values ${helm.name}` })
    else if (chart) commands.push({ label: "kubectl", value: `kubectl -n ${ns} edit helmchart ${chart}` })
  }

  if (kind === "volume") {
    if (slots.ref) commands.push({ label: "kubectl", value: `kubectl -n ${ns} describe pvc ${slots.ref}` })
    if (slots.ref) commands.push({ label: "kubectl", value: `kubectl get storageclass` })
  }

  if (kind === "rbac") {
    if (slots.ref) commands.push({ label: "kubectl", value: `kubectl auth can-i --list --as=system:serviceaccount:${ns}:${slots.ref}` })
    if (slots.ref) commands.push({ label: "kubectl", value: `kubectl -n ${ns} get rolebinding,clusterrolebinding -o wide | grep ${slots.ref}` })
  }

  if (kind === "placement") {
    commands.push({ label: "kubectl", value: `kubectl -n ${ns} describe pod ${facts.name}` })
    commands.push({ label: "kubectl", value: `kubectl get nodes -o custom-columns=NAME:.metadata.name,TAINTS:.spec.taints` })
    commands.push({ label: "kubectl", value: `kubectl get nodes --show-labels` })
  }

  if (kind === "cleanup") {
    commands.push({ label: "kubectl", value: `kubectl -n ${ns} delete pod --field-selector=status.phase==Failed` })
  }

  if (kind === "dependency") {
    const service = resolveService(slots.service, facts)
    if (service) {
      commands.push({ label: "kubectl", value: `kubectl -n ${ns} get pod ${service}` })
      commands.push({ label: "kubectl", value: `kubectl -n ${ns} logs ${service} --tail=50` })
    }
  }

  if (kind === "node" && facts.nodeName) {
    commands.push({ label: "kubectl", value: `kubectl describe node ${facts.nodeName}` })
    commands.push({ label: "kubectl", value: `kubectl -n ${ns} delete pod --field-selector=status.phase==Failed` })
  }

  return commands
}

export function checkText(kind: FixKind, slots: FixSlots, facts: DiagnosisFacts): string {
  const owner = [facts.ownerKind, facts.ownerName].filter(Boolean).join(" ") || "this workload"
  const total = facts.siblings.total
  const runsToCompletion = facts.ownerKind === "Job" || facts.ownerKind === "CronJob"
  if (runsToCompletion && kind !== "cleanup" && kind !== "node") return `A new pod from ${owner} reaches Completed and the job stops creating pods`

  if (kind === "config") return `All ${total} pod${total === 1 ? "" : "s"} of ${owner} reach Running and Ready`
  if (kind === "resources") return `Restarts stay at ${facts.podStatus.restarts} for an hour and ${slots.resource ?? "memory"} settles under ${slots.suggested ?? "the new limit"}`
  if (kind === "node") return `Pressure on ${facts.nodeName ?? "the node"} returns to none and no new pods are evicted`
  if (kind === "manager") return `A new pod from ${owner} reaches Running`
  if (kind === "cleanup") return `${facts.namespace} shows no ${facts.podStatus.display} pods`
  if (kind === "dependency") return `${resolveService(slots.service, facts) ?? slots.service ?? "the dependency"} is Running and this pod stops restarting`
  if (kind === "image") return `The image pull succeeds and the pod leaves ${facts.podStatus.display}`
  if (kind === "spec") return `A new pod from ${owner} starts with ${slots.path ?? "the corrected field"} and stays Ready`
  if (kind === "namespace") return `namespace ${slots.ref ?? "it needs"} exists and ${facts.name} starts`
  if (kind === "volume") return `${slots.ref ?? "the claim"} is Bound and the pod mounts it`
  if (kind === "rbac") return `${facts.name} stops logging permission errors and reaches Ready`
  if (kind === "placement") return `${facts.name} is scheduled onto a node and leaves Pending`
  return `${facts.name} reaches Running and Ready`
}
