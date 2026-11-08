"use client"
import type { ImageUsage } from "@/lib/cluster/reports"
import InspectionCommands, { shellQuote as q } from "../inspection-commands"

export default function ImageInspection({ usage }: { usage: ImageUsage }) {
  const info = usage.imageInfo
  const commands: { label: string; command: string }[] = []
  if (info.containerImage) commands.push({ label: "ContainerImage, OCI metadata and SBOM references", command: `kubectl get containerimage.codemowers.io ${q(info.containerImage)} -o yaml` })
  for (const source of info.sourceRepositories ?? []) {
    if (source.name) commands.push({ label: "Linked SourceRepository", command: `kubectl get sourcerepository.codemowers.io ${q(source.name)} -o yaml` })
  }
  const ns = info.scannerNamespace
  if (ns) {
    commands.push({ label: "Scan queue and completed jobs", command: `kubectl -n ${q(ns)} get jobs -l app=driftmower-scan` })
    for (const key of info.sbomArtifacts ?? []) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue
      const selector = `driftmower.io/scan-key=${key.slice(0, 40)}`
      commands.push({ label: "SBOM scan job (until job cleanup)", command: `kubectl -n ${q(ns)} get jobs -l ${q(selector)} -o yaml` })
      commands.push({ label: "Trivy scan logs", command: `kubectl -n ${q(ns)} logs -l ${q(selector)} -c trivy --prefix=true` })
    }
    if (info.sbomArtifacts?.some(key => /^[a-f0-9]{64}$/.test(key))) {
      commands.push({ label: "Open a local connection to the SBOM cache (keep running in another terminal)", command: `kubectl -n ${q(ns)} port-forward service/driftmower-operator 18080:8080` })
      for (const key of info.sbomArtifacts ?? []) {
        if (!/^[a-f0-9]{64}$/.test(key)) continue
        commands.push({ label: "Read cached CycloneDX SBOM (requires permission to create the MCP service-account token)", command: `curl --fail --silent --show-error -H "Authorization: Bearer $(kubectl -n ${q(ns)} create token driftmower-mcp --audience=${q(`driftmower-scans.${ns}`)} --duration=10m)" ${q(`http://127.0.0.1:18080/v1/sboms/${key}`)}` })
      }
    }
  }
  return <InspectionCommands commands={commands}><p className="mt-2 text-xs text-muted-foreground">ContainerImage annotations reference SBOM artifacts. Full CycloneDX documents live in the operator’s temporary cache and may expire; they are not stored in the CRD.</p></InspectionCommands>
}
