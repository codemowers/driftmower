import "server-only"

import { KubeApiError, KubeTransportError } from "./k8s"

export type ApiErrorBody = {
  error: string
  detail?: string
  reason?: string
  cause?: string
}

const PASS_THROUGH_KUBE_STATUSES = new Set([400, 403, 404, 409, 410, 422, 429])
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"])

export function causeOf(e: unknown): string | undefined {
  const cause = (e as { cause?: unknown } | null)?.cause
  if (!cause || typeof cause !== "object") return undefined
  const { code, message } = cause as { code?: unknown; message?: unknown }
  if (typeof code === "string") return code
  return typeof message === "string" ? message : undefined
}

function describe(e: unknown): { status: number; body: ApiErrorBody; alreadyLogged: boolean } {
  if (e instanceof KubeApiError) {
    const status = PASS_THROUGH_KUBE_STATUSES.has(e.status) ? e.status : 502
    const summary = `Kubernetes API returned ${e.status}${e.reason ? ` ${e.reason}` : ""}`
    return { status, body: { error: summary, detail: e.kubeMessage, reason: e.reason ?? undefined }, alreadyLogged: true }
  }
  if (e instanceof KubeTransportError) {
    const status = TIMEOUT_CODES.has(e.code) ? 504 : 502
    return { status, body: { error: "Kubernetes API unreachable", detail: e.message, cause: e.code }, alreadyLogged: true }
  }
  const message = e instanceof Error ? e.message : String(e)
  const cause = causeOf(e)
  if (cause) {
    const status = TIMEOUT_CODES.has(cause) ? 504 : 502
    return { status, body: { error: message, cause }, alreadyLogged: false }
  }
  return { status: 500, body: { error: message }, alreadyLogged: false }
}

export function errorResponse(e: unknown, tag: string, context = "", init?: ResponseInit): Response {
  const { status, body, alreadyLogged } = describe(e)
  if (!alreadyLogged) {
    const where = context ? `${context} ` : ""
    const cause = body.cause ? ` (cause: ${body.cause})` : ""
    console.error(`[${tag}] ${where}-> ${status}: ${body.error}${cause}`)
  }
  return Response.json(body, { ...init, status })
}
