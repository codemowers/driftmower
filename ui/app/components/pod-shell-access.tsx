"use client"
import Card from "@/app/components/layout/card"
import CommandRow from "@/app/components/command-row"
import { useKubectl } from "@/lib/hooks/use-kubectl"
import { useImageAnalysis } from "@/lib/features/image-analysis"
import { shellQuote } from "@/lib/utils/shell"
import type { ImageUsage } from "@/lib/cluster/reports"

export default function PodShellAccess({ namespace, name, usages }: { namespace: string; name: string; usages: ImageUsage[] }) {
  const analysis=useImageAnalysis(usages.map(u=>u.imageInfo.digest))
  const kubectl=useKubectl()
  return <>
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
