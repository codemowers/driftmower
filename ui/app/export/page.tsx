"use client"
import { ICONS } from "@/app/components/layout/icons"

import { useMemo, useState } from "react"
import PageHeader from "../components/page-header"
import SummaryBar from "./components/summary-bar"
import ArtifactList from "./components/artifact-list"
import CreateSandbox from "./components/create-sandbox"
import ExportBar from "./components/export-bar"
import { ALL_ARTIFACTS, ARTIFACT_GROUPS, BUNDLE_FILENAME, SANDBOXES, formatSize, type ArtifactClass } from "./data"

const CHART_COUNT = ARTIFACT_GROUPS.filter(g => g.kind === "helm").length

export default function ExportPage() {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(ALL_ARTIFACTS.map(a => a.id)))

  const { selectedCount, selectedSize } = useMemo(() => {
    const picked = ALL_ARTIFACTS.filter(a => selected.has(a.id))
    return { selectedCount: picked.length, selectedSize: picked.reduce((n, a) => n + a.sizeBytes, 0) }
  }, [selected])

  function toggle(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleClass(category: ArtifactClass) {
    const ids = ALL_ARTIFACTS.filter(a => a.category === category).map(a => a.id)
    setSelected(prev => {
      const next = new Set(prev)
      const allIn = ids.every(id => next.has(id))
      for (const id of ids) {
        if (allIn) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  return (
    <div className="flex h-screen flex-col gap-6 overflow-hidden px-7 py-8">
      <PageHeader icon={ICONS.export}
        title="Export shipping artifacts"
        subtitle="Package every image, chart, and manifest into one signed, portable bundle for air-gapped delivery."
      />

      <SummaryBar artifacts={ALL_ARTIFACTS} chartCount={CHART_COUNT} />

      <div className="grid min-h-0 flex-1 grid-cols-[3fr_2fr] gap-5">
        <ArtifactList
          artifacts={ALL_ARTIFACTS}
          selected={selected}
          onToggle={toggle}
          onToggleClass={toggleClass}
        />
        <CreateSandbox sandboxes={SANDBOXES} className="self-start" />
      </div>

      <ExportBar count={selectedCount} sizeLabel={formatSize(selectedSize)} filename={BUNDLE_FILENAME} />
    </div>
  )
}
