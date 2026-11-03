import "server-only"

export class LivePatchUpgradeError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "LivePatchUpgradeError"
    this.status = status
  }
}
