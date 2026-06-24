export type ResourceTriplet = {
  usage: number | null
  limit: number | null
  request: number | null
}

export type PodVolume = {
  name: string
  used: number
  capacity: number
}

export type VectorRow = { metric: Record<string, string>; value: [number, string] }

export async function queryScalar(promql: string): Promise<number | null> {
  const res = await fetch(`/api/prometheus/query?query=${encodeURIComponent(promql)}`, { cache: "no-store" })
  if (!res.ok) return null
  const json = await res.json() as { data?: { result?: { value?: [number, string] }[] } }
  const raw = json.data?.result?.[0]?.value?.[1]
  if (raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export async function queryVector(promql: string): Promise<VectorRow[]> {
  const res = await fetch(`/api/prometheus/query?query=${encodeURIComponent(promql)}`, { cache: "no-store" })
  if (!res.ok) return []
  const json = await res.json() as { data?: { result?: VectorRow[] } }
  return json.data?.result ?? []
}

export function pairVolumes(usedRows: VectorRow[], capacityRows: VectorRow[]): PodVolume[] {
  const capacityByPvc = new Map<string, number>()
  for (const row of capacityRows) {
    const pvc = row.metric.persistentvolumeclaim
    const value = Number(row.value[1])
    if (pvc && Number.isFinite(value)) capacityByPvc.set(pvc, value)
  }

  const volumes: PodVolume[] = []
  for (const row of usedRows) {
    const pvc = row.metric.persistentvolumeclaim
    if (!pvc) continue
    const used = Number(row.value[1])
    const capacity = capacityByPvc.get(pvc)
    if (!Number.isFinite(used) || capacity === undefined) continue
    volumes.push({ name: pvc, used, capacity })
  }

  return volumes.sort((a, b) => fullness(b) - fullness(a))
}

function fullness(volume: PodVolume): number {
  return volume.capacity > 0 ? volume.used / volume.capacity : 0
}
