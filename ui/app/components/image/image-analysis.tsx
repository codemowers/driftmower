"use client"
import Card from "@/app/components/layout/card"
import type { useImageAnalysis } from "@/lib/features/image-analysis"

export default function ImageAnalysisCard({ digest, result }: { digest: string; result: ReturnType<typeof useImageAnalysis> }) {
  const artifacts = result.data?.images[digest]
  return <Card title="Static image analysis">
    {result.error ? <p role="alert" className="text-sm text-status-major-label">Image analysis unavailable: {result.error}</p>
      : !artifacts ? <p className="text-sm text-muted-foreground">Loading image analysis…</p>
      : !artifacts.length ? <p className="text-sm text-muted-foreground">No image analysis is available.</p>
      : artifacts.map(a => <div key={a.digest} className="flex min-w-0 flex-col gap-4 border-b last:border-b-0 pb-4 last:pb-0">
        {artifacts.length > 1 && <p className="break-all font-mono text-xs text-muted-foreground">{a.digest}</p>}
        {!a.analysis ? <p className="text-sm text-muted-foreground">{a.status === "pending" ? "Awaiting image analysis from a scan Pod." : "Analysis has expired or is unavailable."}</p> : <>
          <p className="text-sm">{a.analysis.filesObserved} regular files, {a.analysis.directoriesObserved} directories and {a.analysis.symlinksObserved} symlinks observed. {a.analysis.truncated ? `Incomplete enumeration: ${a.analysis.entriesExamined} entries examined; full counts are unknown.` : `${a.analysis.entriesExamined} entries examined across the image.`}</p>
          <dl className="grid grid-cols-[minmax(140px,auto)_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Build time (config JSON)</dt><dd>{a.configCreated ? new Date(a.configCreated).toLocaleString() : "Unknown"}</dd>
            <dt className="text-muted-foreground">Latest file modification</dt><dd>{a.analysis.latestFileModifiedAt ? new Date(a.analysis.latestFileModifiedAt).toLocaleString() : "Unknown"}{a.analysis.latestFilePath && <span className="block break-all font-mono text-xs text-muted-foreground">{a.analysis.latestFilePath}</span>}</dd>
          </dl>
          <p className="text-xs text-muted-foreground">Build time is declared image metadata. File modification times may be preserved or normalized during a build and do not establish when the image was built.</p>
          <p className="text-xs text-muted-foreground">Inspected {new Date(a.analysis.observedAt).toLocaleString()}. File types use content signatures; no image code is executed.{!!a.analysis.errors?.length && " Some paths could not be inspected; coverage is incomplete."}</p>
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead className="text-left text-xs text-muted-foreground"><tr><th className="py-2">MIME type</th><th className="text-right">Observed files</th></tr></thead><tbody>{Object.entries(a.analysis.mimeTypes ?? {}).sort((a,b) => b[1]-a[1]).map(([type,count]) => <tr key={type} className="border-t"><td className="py-2 font-mono text-xs">{type}</td><td className="text-right tabular-nums">{count}</td></tr>)}</tbody></table></div>
          <p className="text-sm">ELF linking evidence: {Object.entries(a.analysis.linkingCounts ?? {}).map(([kind,n]) => `${n} ${kind}`).join(" · ") || "no ELF executables observed"}.{a.analysis.binariesTruncated && " Binary detail list is capped."}</p>
          <p className="text-sm">Shell files at standard locations: {a.analysis.shells?.map(s => s.path).join(", ") || "none detected"}. Presence does not prove that a shell will run with this Pod’s permissions.</p>
          {!!a.analysis.tools?.busybox?.length && <p className="text-sm">BusyBox: {a.analysis.tools.busybox.join(", ")}. Applets have not been executed.</p>}
          {!!a.analysis.binaries?.length && <details><summary className="cursor-pointer text-sm">ELF executable evidence ({a.analysis.binaries.length})</summary><ul className="mt-2 divide-y">{a.analysis.binaries.map(b => <li key={b.path} className="py-2 text-xs"><span className="break-all font-mono">{b.path}</span> · {b.linking}{b.architecture && ` · ${b.architecture}`}{b.interpreter && ` · interpreter ${b.interpreter}`}{!!b.needed?.length && ` · requires ${b.needed.join(", ")}`}{b.error && ` · ${b.error}`}</li>)}</ul></details>}
          {!!a.analysis.newestFiles?.length && <details><summary className="cursor-pointer text-sm">Newest files ({a.analysis.newestFiles.length}{a.analysis.newestFilesTruncated ? ` of ${a.analysis.filesObserved} observed` : ""})</summary><div className="mt-2 overflow-x-auto"><table className="w-full text-xs"><thead className="text-left text-muted-foreground"><tr><th className="py-2">Path</th><th>Modified</th><th>MIME type</th><th className="text-right">Bytes</th></tr></thead><tbody>{a.analysis.newestFiles.map(f => <tr key={f.path} className="border-t"><td className="break-all py-2 font-mono">{f.path}</td><td className="whitespace-nowrap">{new Date(f.modifiedAt).toLocaleString()}</td><td>{f.mimeType}</td><td className="text-right tabular-nums">{f.size}</td></tr>)}</tbody></table></div></details>}
          {!!a.analysis.errors?.length && <details><summary className="cursor-pointer text-sm">Inspection limits and errors</summary><ul className="mt-2 text-xs text-muted-foreground">{a.analysis.errors.map((e,i) => <li key={i}>{e}</li>)}</ul></details>}
        </>}
      </div>)}
  </Card>
}
