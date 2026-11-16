export type VolumeUsage = { usedBytes: number | null; capacityBytes: number | null; inodes: number | null; inodesUsed: number | null }
export type Claim = {
  namespace: string; name: string; uid: string; phase: string | null; storageClass: string | null
  requestedStorage: string | null; provisionedStorage: string | null; volumeMode: string; accessModes: string[]
  boundVolume: string | null; usage: VolumeUsage; canExpand: boolean; usedBy: { name: string; uid: string }[]
}
export type PersistentVolume = {
  name: string; uid: string; phase: string | null; capacityStorage: string | null; storageClass: string | null
  volumeMode: string; accessModes: string[]; reclaimPolicy: string | null; csiDriver: string | null
  claim: { namespace: string; name: string; uid?: string } | null
  lastPhaseTransitionTime: string | null; affinity: { kind: "node" | "zone"; values: string[] } | null
}
export type StorageClass = {
  name: string; provisioner: string; parameters: Record<string, string>; reclaimPolicy: string
  volumeBindingMode: string; allowVolumeExpansion: boolean; mountOptions: string[]
}
export type Volumes = { claims: Claim[]; persistentVolumes: PersistentVolume[]; storageClasses: StorageClass[]; prometheusUrl: string | null; degraded: { source: string; message: string }[] }
export type VolumeDetail = {
  claim: Claim | null; persistentVolume: PersistentVolume | null; storageClass: StorageClass | null
  claimState: "exists" | "missing" | "replaced" | "unbound" | "unknown"; warnings: string[]
}

export function volumePath(claim: Pick<Claim, "namespace" | "name" | "boundVolume"> | null, pv?: Pick<PersistentVolume, "name"> | null): string {
  if (claim) return `/volumes/pvc/${encodeURIComponent(claim.namespace)}/${encodeURIComponent(claim.name)}`
  return `/volumes/pv/${encodeURIComponent(pv?.name ?? "")}`
}
