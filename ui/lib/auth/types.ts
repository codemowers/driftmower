export interface SessionClaims {
  sub: string
  name?: string
  email?: string
  groups: string[]
}
