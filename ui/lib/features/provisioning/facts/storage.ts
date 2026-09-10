import "server-only"

import { kubeApiGet } from "@/lib/server/k8s"
import { createTtlCache } from "@/lib/utils/ttl-cache"
import { CLUSTER_FACT_TTL_MS } from "../constants"
import { toStorageClassFact, type RawStorageClass } from "../storage-facts"
import type { Fact, StorageClassFact } from "../types"
import { optional } from "./tolerate"

async function listStorageClasses(): Promise<Fact<StorageClassFact[]>> {
  return await optional("storageclasses", async () => {
    const list = await kubeApiGet<{ items?: RawStorageClass[] }>("/apis/storage.k8s.io/v1/storageclasses")
    return (list.items ?? [])
      .map(toStorageClassFact)
      .filter((c): c is StorageClassFact => c !== null)
      // Default first, then alphabetical: the default is what a beginner gets
      // when they express no preference, so it belongs at the top of the list.
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
  })
}

export const getStorageClasses = createTtlCache(CLUSTER_FACT_TTL_MS, listStorageClasses)
