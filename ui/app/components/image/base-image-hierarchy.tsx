"use client"

import { useState } from "react"
import { ArrowDown } from "lucide-react"
import { useRegistryQuery } from "@/lib/features/base-images/use-registry-query"
import { platformName, preferredTag, type HierarchyResult, type Target } from "@/lib/features/base-images/types"
import BaseImageDetails from "./base-image-details"
import { cn } from "@/lib/utils/cn"

type Picked = { repository: string; digest: string }

// The image's filesystem ancestry in the registry catalog. Picking a matched
// base image shows its details below.
export default function BaseImageHierarchy({ images, targetLabel }: { images: Target[]; targetLabel: string }) {
  const [picked, setPicked] = useState<Picked | null>(null)
  const [selected, setSelected] = useState("")
  const unique = [...new Map(images.map(image => [image.digest + platformName(image.platform), image])).values()]
  const target = unique.find(image => image.digest + platformName(image.platform) === selected) ?? unique[0]
  const result = useRegistryQuery<HierarchyResult>("get_base_image_hierarchy", { images: target ? [target] : [] }, !!target)
  const hierarchy = result?.data?.hierarchies[0]
  const stages = hierarchy?.stages.map(stage => ({ ...stage, candidates: stage.candidates.filter(candidate => candidate.digest !== target?.digest) })).filter(stage => stage.candidates.length) ?? []
  return (
    <>
    <section className="rounded-xl border border-gray-200 bg-white px-5 py-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Base image hierarchy</h2>
        {unique.length > 1 && <select aria-label="Image platform and digest" className="max-w-full rounded border px-2 py-1 text-xs" value={target.digest + platformName(target.platform)} onChange={event => setSelected(event.target.value)}>{unique.map(image => <option key={image.digest + platformName(image.platform)} value={image.digest + platformName(image.platform)}>{platformName(image.platform)} · {image.digest.slice(7, 19)}</option>)}</select>}
      </div>
      {!target ? <p className="text-sm text-muted-foreground">Ordered image layers are not available.</p>
        : result?.error ? <p className="text-sm text-muted-foreground">Base image catalog unavailable: {result.error}</p>
          : !hierarchy ? <p className="text-sm text-muted-foreground">Looking up image ancestry…</p>
            : <>
              <div className="flex flex-col items-start gap-2">
                <div className="rounded-lg bg-gray-50 px-4 py-2 font-mono text-sm">scratch <span className="font-sans text-xs text-muted-foreground">· empty filesystem</span></div>
                {stages.map(stage => <div key={stage.layerCount} className="flex w-full flex-col items-start gap-2">
                  <ArrowDown className="ml-4 size-4 text-muted-foreground" />
                  <div className="w-full rounded-lg border px-4 py-3">
                    <p className="mb-2 text-xs text-muted-foreground">{stage.layerCount} inherited layers{stage.candidates.length > 1 ? " · alternative matching images" : ""}</p>
                    <div className="flex flex-wrap gap-2">{stage.candidates.slice(0, 5).map(candidate => <button type="button" key={candidate.repository + candidate.digest} onClick={() => setPicked({ repository: candidate.repository, digest: candidate.digest })} aria-pressed={picked?.digest === candidate.digest} className={cn("rounded px-2 py-1 font-mono text-sm hover:underline", picked?.digest === candidate.digest ? "bg-brand text-white" : "bg-brand-bg text-brand-text")} title={`${candidate.repository}@${candidate.digest}\n${candidate.tags.join(", ")}\n${candidate.evidence}`}>{candidate.repository.replace(/^docker\.io\/library\//, "")}:{preferredTag(candidate.tags)}</button>)}</div>
                    {stage.candidates.length > 5 && <details className="mt-2 text-xs"><summary className="cursor-pointer">{stage.candidates.length - 5} more alternatives</summary>{stage.candidates.slice(5).map(candidate => <p key={candidate.repository + candidate.digest} className="mt-1"><button type="button" onClick={() => setPicked({ repository: candidate.repository, digest: candidate.digest })} className="text-brand-text hover:underline">{candidate.repository}:{preferredTag(candidate.tags)}</button></p>)}</details>}
                    {stage.truncated && <p className="mt-2 text-xs text-muted-foreground">Additional matching images omitted.</p>}
                  </div>
                </div>)}
                <ArrowDown className="ml-4 size-4 text-muted-foreground" />
                <div className="max-w-full rounded-lg bg-brand-bg px-4 py-2"><p className="break-all font-mono text-sm font-semibold">{targetLabel}</p><p className="mt-1 text-xs text-muted-foreground">{platformName(target.platform)} · {target.layers.length} layers</p></div>
              </div>
              {stages.length === 0 && <p className="mt-4 text-sm text-muted-foreground">No intermediate base images are indexed for this layer chain yet.</p>}
              <p className="mt-4 text-xs text-muted-foreground">Ordered layer matches from the registry catalog. They show shared filesystem ancestry; intermediate images may be missing and a Dockerfile parent may be ambiguous.</p>
            </>}
    </section>
    {picked && <BaseImageDetails key={picked.digest} repository={picked.repository} digest={picked.digest} />}
    </>
  )
}
