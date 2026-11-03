"use client"

import { useState } from "react"
import { ChevronRight, SquareTerminal } from "lucide-react"
import { cn } from "@/lib/utils/cn"
import CopyButton from "@/app/components/copy-button"

type Props = {
  kind: string
  namespace: string
  name: string
  apiGroup?: string
}

const RESTARTABLE_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet"])

function resourceToken(kind: string, apiGroup?: string): string {
  if (RESTARTABLE_KINDS.has(kind)) return kind.toLowerCase()
  const group = apiGroup && apiGroup !== "v1" && apiGroup !== "core" ? apiGroup.split("/")[0] : ""
  const plural = `${kind.toLowerCase()}s`
  return group ? `${plural}.${group}` : plural
}

type Command = { label: string; value: string }

function buildCommands(kind: string, namespace: string, name: string, apiGroup?: string) {
  const token = resourceToken(kind, apiGroup)
  const inspect: Command[] = [
    { label: "get", value: `kubectl get ${token} -n ${namespace} ${name}` },
    { label: "events", value: `kubectl events -n ${namespace} ${token} ${name}` },
  ]
  const restart: Command[] = RESTARTABLE_KINDS.has(kind)
    ? [{ label: "restart", value: `kubectl rollout restart -n ${namespace} ${token} ${name}` }]
    : []
  return { inspect, restart }
}

function CommandRow({ label, value }: Command) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-gray-100 px-3 py-2">
      <span className="w-16 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <code className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[12.5px] text-foreground">
        {value}
      </code>
      <CopyButton value={value} className="shrink-0" />
    </div>
  )
}

export default function CommandsCard({ kind, namespace, name, apiGroup }: Props) {
  const [expanded, setExpanded] = useState(false)
  const { inspect, restart } = buildCommands(kind, namespace, name, apiGroup)

  const summaryParts = ["inspect", "events"]
  if (restart.length) summaryParts.push("restart")

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Commands
      </p>
      <div className="rounded-xl border border-gray-200 bg-white">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-4 rounded-xl px-5 py-4 text-left transition-colors hover:bg-gray-50"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-bg text-brand-icon">
            <SquareTerminal className="size-6" strokeWidth={2} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-foreground">kubectl</span>
            <span className="block font-mono text-xs text-muted-foreground">
              {summaryParts.join(", ")}
            </span>
          </span>
          <ChevronRight
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
          />
        </button>

        {expanded && (
          <div className="border-t border-gray-200 px-5 pb-4 pt-3">
            <div className="flex flex-col gap-2.5">
              {inspect.map(c => (
                <CommandRow key={c.label} {...c} />
              ))}
            </div>

            {restart.length > 0 && (
              <div className="mt-3 flex flex-col gap-2.5 border-t border-gray-200 pt-3">
                {restart.map(c => (
                  <CommandRow key={c.label} {...c} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
