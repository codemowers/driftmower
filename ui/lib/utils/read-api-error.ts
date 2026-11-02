const SNIPPET_MAX = 200

type ErrorBody = { error?: unknown; detail?: unknown; cause?: unknown }

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

function explain(text: string): string | null {
  try {
    const body = JSON.parse(text) as ErrorBody
    const error = textOf(body.error)
    const detail = textOf(body.detail)
    const cause = textOf(body.cause)
    const isMachineCode = error !== null && /^[a-z0-9_]+$/.test(error)
    const main = detail && error && !isMachineCode && !detail.includes(error) ? `${error}: ${detail}` : detail ?? error
    if (main) return cause ? `${main} (${cause})` : main
  } catch {}
  const snippet = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX)
  return snippet || null
}

export async function readApiError(res: Response): Promise<string> {
  const status = `${res.status}${res.statusText ? ` ${res.statusText}` : ""}`
  const text = await res.text().catch(() => "")
  const reason = explain(text)
  return reason ? `${status}: ${reason}` : status
}
