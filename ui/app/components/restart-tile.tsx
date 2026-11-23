"use client"

import { useEffect, useRef, useState } from "react"
import { AlertTriangle, LoaderCircle, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { ClusterResource } from "@/lib/cluster/cluster-state"
import Card from "@/app/components/layout/card"
import { callTool } from "@/browser/connection"

export type RestartTarget = { namespace: string; kind: string; apiVersion: string; name: string; uid: string; managerKind: "argo" | "standalone" }

type Props = { target: RestartTarget; restartedAt: string | null; pods: ClusterResource[] }

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

const AGE_UNITS: [number, (n: number) => string][] = [
  [365 * DAY_MS, n => plural(n, "year")],
  [30 * DAY_MS, n => plural(n, "month")],
  [DAY_MS, n => plural(n, "day")],
  [HOUR_MS, n => `${n}h`],
  [MINUTE_MS, n => `${n} min`],
]

function restartAge(iso: string): string {
  const elapsed = Date.now() - Date.parse(iso)
  const unit = AGE_UNITS.find(([ms]) => elapsed >= ms)
  return unit ? `${unit[1](Math.round(elapsed / unit[0]))} ago` : "just now"
}

function rolledOut(pods: ClusterResource[], since: string): boolean {
  return pods.length > 0 && pods.every(pod => pod.podStatus?.ready && (pod.createdAt ?? "") >= since)
}

function ConfirmDialog({ target, onCancel, onConfirm }: { target: RestartTarget; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-muted/85 px-4" onClick={onCancel}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="restart-dialog-title"
        className="flex w-full max-w-[440px] flex-col gap-3.5 rounded-lg border border-border bg-background px-7 pt-6 pb-5"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <RotateCcw className="size-6 shrink-0 text-brand-icon" aria-hidden />
          <h2 id="restart-dialog-title" className="text-[20px] font-semibold">Restart {target.kind}?</h2>
        </div>
        <p className="break-all font-mono text-sm text-foreground">{target.name}</p>
        <p className="text-sm text-muted-foreground">Pods are replaced one at a time. Old pods keep running until the new ones are ready.</p>
        <div className="flex justify-end gap-2">
          <Button ref={cancelRef} type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button type="button" onClick={onConfirm}>Restart</Button>
        </div>
      </div>
    </div>
  )
}

export default function RestartTile({ target, restartedAt, pods }: Props) {
  const [confirming, setConfirming] = useState(false)
  const [requestedAt, setRequestedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const since = requestedAt ?? restartedAt
  const restarting = since !== null && !rolledOut(pods, since)

  async function restart() {
    setConfirming(false)
    setError(null)
    const { namespace, name, uid, apiVersion, kind } = target
    const startedAt = new Date().toISOString()
    try {
      await callTool("restart_workload", { namespace, name, uid, apiVersion, kind })
      setRequestedAt(startedAt)
    } catch (e) {
      console.error(`[workload-restart] ${target.kind} ${target.namespace}/${target.name}: ${(e as Error).message}`)
      setError((e as Error).message)
    }
  }

  const tile = (
    <button
      type="button"
      disabled={restarting}
      aria-expanded={confirming}
      onClick={() => setConfirming(open => !open)}
      className="inline-flex w-fit items-center gap-2 rounded-md bg-brand-bg px-3 py-2 text-sm font-medium text-brand-label hover:bg-brand-bg/70 disabled:opacity-50"
    >
      {restarting ? <LoaderCircle className="size-5.5 animate-spin text-brand-icon motion-reduce:animate-none" aria-hidden />
        : error ? <AlertTriangle className="size-5.5 text-status-major-label" aria-hidden />
        : <RotateCcw className="size-5.5 text-brand-icon" aria-hidden />}
      <span className="text-xs font-medium text-foreground">{restarting ? "Restarting" : error ? "Failed" : "Restart"}</span>
      {!restarting && !error && restartedAt && (
        <span className="font-mono text-[10px] text-muted-foreground">{restartAge(restartedAt)}</span>
      )}
    </button>
  )

  return (
    <Card title="Actions">
      {error ? (
        <Tooltip>
          <TooltipTrigger asChild>{tile}</TooltipTrigger>
          <TooltipContent className="max-w-xs break-words">Restart failed: {error}</TooltipContent>
        </Tooltip>
      ) : tile}
      {confirming && <ConfirmDialog target={target} onCancel={() => setConfirming(false)} onConfirm={() => void restart()} />}
    </Card>
  )
}
