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

export type PromQuery = {
  scalar: (promql: string) => Promise<number | null>
  vector: (promql: string) => Promise<VectorRow[]>
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
