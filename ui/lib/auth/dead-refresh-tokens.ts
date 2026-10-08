// Refresh tokens the IdP has answered `invalid_grant` for.
//
// passmower ends every refresh token with the session that issued it
// (`expiresWithSession`), so signing in to passmower again kills the one in a
// driftmower cookie. Nothing can revive it, but the cookie still carries it and
// its access token stays valid for up to an hour, and every request that wants
// a platform-manager token would ask the IdP again: one session on bravo made
// 147 such grants in 39 minutes. Remembering the verdict stops that, and lets
// the next request that can write cookies end the session.
//
// Process memory, like the platform-manager token cache: this BFF is a single
// replica. Pure and relative-import only so `node --test` can load it.

// Past this, the access token the cookie also carries has expired too, and the
// ordinary refresh path finds the token dead on its own.
export const DEAD_TOKEN_TTL_MS = 60 * 60 * 1000

export function createDeadTokenRegistry(now: () => number = Date.now) {
  const dead = new Map<string, number>()

  return {
    mark(token: string): void {
      const at = now()
      dead.set(token, at + DEAD_TOKEN_TTL_MS)
      for (const [key, expiresAt] of dead) {
        if (expiresAt <= at) dead.delete(key)
      }
    },
    has(token: string | undefined): boolean {
      if (!token) return false
      const expiresAt = dead.get(token)
      if (expiresAt === undefined) return false
      if (expiresAt > now()) return true
      dead.delete(token)
      return false
    },
    get size(): number {
      return dead.size
    },
  }
}

// Only `invalid_grant` means the token itself is gone. Other rejections, such
// as `invalid_target` for a resource the grant lacks, can be configuration;
// ending the session on those would send the user round a sign-in loop.
export function isDeadTokenError(error: unknown): boolean {
  return (error as { error?: unknown } | null)?.error === "invalid_grant"
}
