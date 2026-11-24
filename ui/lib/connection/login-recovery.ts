type AttemptStore = Pick<Storage, "getItem" | "setItem" | "removeItem">

export const loginReturnKey = (endpoint: string) => `driftmower.login-return:${endpoint}`
export const loginRecoveryKey = (endpoint: string) => `driftmower.login-recovery:${endpoint}`

// Missing one-time state cannot be accepted as authentication. Start a new
// transaction once, keeping verification failures and repeated failures visible.
export function claimLoginRecovery(error: unknown, endpoint: string, storage: AttemptStore): boolean {
  if (!(error instanceof Error) || error.message !== "No matching state found in storage") return false
  const key = loginRecoveryKey(endpoint)
  if (storage.getItem(key)) return false
  storage.setItem(key, "1")
  return true
}
