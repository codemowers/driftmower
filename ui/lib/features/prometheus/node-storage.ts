// Per node: the TopoLVM volume group's allocation, for PersistentVolumes,
// and the root filesystem, for images, logs and emptyDirs.
export type StorageUsage = { used: number; total: number; graph?: string[] }
export type NodeStorageMap = Record<string, { lvm?: StorageUsage; ephemeral?: StorageUsage }>
