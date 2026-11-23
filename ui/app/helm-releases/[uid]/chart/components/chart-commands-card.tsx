"use client"

import CommandRow from "@/app/components/command-row"
import { useState } from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils/cn"

type Props = {
  chartSource: string
  repoUrl?: string
  version?: string
}

type Command = { label: string; value: string }

export function isAbsoluteChartRef(chartSource: string): boolean {
  return /^(oci|https?):\/\//.test(chartSource)
}

export function canBuildChartCommands(chartSource?: string, repoUrl?: string): boolean {
  return Boolean(chartSource && (isAbsoluteChartRef(chartSource) || repoUrl))
}

function buildCommands(chartSource: string, repoUrl?: string, version?: string): Command[] {
  const repoFlag = repoUrl && !isAbsoluteChartRef(chartSource) ? ` --repo ${repoUrl}` : ""
  const versionFlag = version ? ` --version ${version}` : ""
  const suffix = `${repoFlag}${versionFlag}`
  return [
    { label: "chart.yaml", value: `helm show chart ${chartSource}${suffix}` },
    { label: "values", value: `helm show values ${chartSource}${suffix}` },
  ]
}


export default function ChartCommandsCard({ chartSource, repoUrl, version }: Props) {
  const [expanded, setExpanded] = useState(false)
  const commands = buildCommands(chartSource, repoUrl, version)

  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-gray-200 bg-white">
      <h2 className="border-b border-gray-200 px-5 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Commands</h2>
      <div className="">
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-4 rounded-xl px-5 py-4 text-left transition-colors hover:bg-gray-50"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-foreground">helm</span>
            <span className="block font-mono text-xs text-muted-foreground">chart.yaml, values</span>
          </span>
          <ChevronRight
            className={cn("size-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
          />
        </button>

        {expanded && (
          <div className="border-t border-gray-200 px-5 pb-4 pt-3">
            <div className="flex flex-col gap-2.5">
              {commands.map(c => (
                <CommandRow key={c.label} {...c} />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
