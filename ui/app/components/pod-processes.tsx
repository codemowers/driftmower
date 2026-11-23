"use client"
import { useCallback } from "react"
import Card from "@/app/components/layout/card"
import CommandRow from "@/app/components/command-row"
import { callTool } from "@/browser/connection"
import { useClusterState } from "@/lib/cluster/cluster-state"
import { useQuery } from "@/lib/hooks/use-query"
import { useKubectl } from "@/lib/hooks/use-kubectl"
import { useImageAnalysis } from "@/lib/features/image-analysis"
import { shellQuote } from "@/lib/utils/shell"
import type { ImageUsage } from "@/lib/cluster/reports"

type Process = { name: string; containerID: string; runtime: string; scope: string; hostPID?: number; hostUID?: number; hostGID?: number; uid?: number; gid?: number; configuredUID: number; configuredGID: number; args: string[] | null; argsSource: string; argsTruncated?: boolean; executable?: string; linking?: string; unknown?: string[] }
type Observation = { available: boolean; reason?: string; observation?: { observedAt: string; containers: Process[]; truncated?: boolean } }
export default function PodProcesses({ namespace, name, uid, usages }: { namespace: string; name: string; uid: string; usages: ImageUsage[] }) {
  const cluster = useClusterState(s => s.clusterName)
  const load = useCallback(async (signal: AbortSignal) => ({ ...await callTool<Observation>("get_pod_processes", { namespace, name, uid }, signal), receivedAt: Date.now() }), [namespace,name,uid])
  const result = useQuery({ key: cluster ? JSON.stringify([cluster,"pod-processes",namespace,name,uid]) : null, load, interval: 30_000 })
  const analysis = useImageAnalysis(usages.map(u => u.imageInfo.digest))
  const kubectl = useKubectl()
  const observation = result.data?.observation
  const age = observation ? (result.data?.receivedAt ?? 0) - Date.parse(observation.observedAt) : 0
  return <>
    <Card title="Container root processes" meta={observation && `Observed ${new Date(observation.observedAt).toLocaleString()}`}>
      {result.error ? <p role="alert" className="text-sm text-status-major-label">Process observation unavailable: {result.error}</p>
        : !result.data ? <p className="text-sm text-muted-foreground">Loading root process observations…</p>
        : !observation ? <p className="text-sm text-muted-foreground">{result.data.reason ?? "No process observation is available."}</p>
        : <>
          {age > 90_000 && <p role="alert" className="text-sm text-status-major-label">This observation is older than 90 seconds and may no longer describe the running processes.</p>}
          {observation.containers?.map(p => <div key={p.containerID} className="flex flex-col gap-2 border-b last:border-b-0 pb-4 last:pb-0 text-sm">
            <p className="font-medium">{p.name} <span className="font-normal text-muted-foreground">· {p.runtime} · {p.scope === "guest" ? "guest process" : p.scope}</span></p>
            <p>Host PID: {p.hostPID ?? "unknown"} · Host UID/GID: {p.hostUID ?? "unknown"}/{p.hostGID ?? "unknown"}</p>
            <p>Process UID/GID: {p.uid ?? "unknown"}/{p.gid ?? "unknown"} · OCI configured UID/GID: {p.configuredUID}/{p.configuredGID}</p>
            <p>Executable: <span className="break-all font-mono text-xs">{p.executable || "unknown"}</span> · Linking: {p.linking || "unknown"}</p>
            <p className="text-xs text-muted-foreground">Arguments from {p.argsSource}; common credentials redacted, shell command text omitted.{p.argsTruncated && " Argument list truncated."}</p>
            <pre className="whitespace-pre-wrap break-all font-mono text-xs">{p.args?.map(shellQuote).join(" ") || "Arguments unavailable"}</pre>
            {p.unknown?.map((reason,i) => <p key={i} className="text-xs text-muted-foreground">{reason}</p>)}
          </div>)}
          {observation.truncated && <p className="text-sm text-muted-foreground">Some container observations were omitted because the observation limit was reached.</p>}
        </>}
    </Card>
    {usages.some(u => analysis.data?.images[u.imageInfo.digest]?.some(a => a.analysis?.shells?.length)) && <Card title="Shell access">
      <p className="text-xs text-muted-foreground">Detected at standard image paths. Copy a command to try opening a shell; runtime permissions and libraries may still prevent execution.</p>
      {[...new Map(usages.map(u => [u.containerName,u])).values()].map(u => {
        const artifacts = analysis.data?.images[u.imageInfo.digest] ?? []
        // For an index, only propose a shell present at the same path in every
        // observed platform; unknown platform coverage never proves availability.
        const reports = artifacts.map(a => a.analysis)
        const shells = reports.length && reports.every(Boolean) ? reports[0]!.shells.filter(s => reports.every(r => r!.shells.some(other => other.path === s.path))) : []
        const shell = shells.find(s => s.path.endsWith("/bash")) ?? shells.find(s => s.path.endsWith("/sh")) ?? shells[0]
        return shell ? <CommandRow key={u.containerName} label={u.containerName} value={`${kubectl("exec",namespace)} --stdin --tty ${shellQuote(name)} --container ${shellQuote(u.containerName)} -- ${shellQuote(shell.path)}`} /> : null
      })}
    </Card>}
  </>
}
