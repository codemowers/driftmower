import { createHash } from "node:crypto"

export const OBJECT_NAME_PREFIX = "driftmower-livepatch-"
const HASH_LENGTH = 12

export function fixHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, HASH_LENGTH)
}

export function objectName(hash: string): string {
  return `${OBJECT_NAME_PREFIX}${hash}`
}
