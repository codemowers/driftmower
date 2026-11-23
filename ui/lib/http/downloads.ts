import { createStore } from "zustand/vanilla"

type DownloadState = { receivedBytes: number; totalBytes: number | null; activeRequests: number }
export const downloadProgress = createStore<DownloadState>(() => ({ receivedBytes: 0, totalBytes: null, activeRequests: 0 }))
let received = 0, expected = 0, unknown = 0, active = 0, updated = 0
let timer: ReturnType<typeof setTimeout> | undefined

function publish(force = false) {
  if (!force && Date.now() - updated < 100) {
    timer ??= setTimeout(() => { timer = undefined; publish(true) }, 100)
    return
  }
  clearTimeout(timer); timer = undefined; updated = Date.now()
  downloadProgress.setState({ receivedBytes: received, totalBytes: unknown ? null : expected, activeRequests: active })
}

// A batch is the currently overlapping responses. Retain counters only, never
// URLs, credentials, response chunks or completed-request records.
export function beginDownload() {
  if (active === 0) { received = 0; expected = 0; unknown = 0 }
  active++; unknown++; publish(true)
  let bytes = 0, total: number | undefined, finished = false
  return {
    size(value: number) {
      if (finished || total !== undefined || !Number.isSafeInteger(value) || value < 0) return
      total = value; expected += value; unknown--; publish(true)
    },
    add(value: number) {
      if (finished) return
      bytes += value; received += value
      if (total !== undefined && bytes > total) { expected -= total; total = undefined; unknown++; publish(true) }
      else publish()
    },
    finish() {
      if (finished) return
      finished = true; active--
      if (total === undefined) { unknown--; expected += bytes }
      else expected += bytes - total
      publish(true)
    },
  }
}

// fetch exposes decoded body chunks. Content-Length is a usable total only
// when we know no content encoding was applied; CORS can hide that header.
export function responseSize(response: Response): number | null {
  const encoding = response.headers.get("Content-Encoding")
  if (encoding && encoding.toLowerCase() !== "identity") return null
  if (!encoding && typeof location !== "undefined" && response.url && new URL(response.url).origin !== location.origin) return null
  const raw = response.headers.get("Content-Length")
  if (!raw || !/^\d+$/.test(raw)) return null
  const size = Number(raw)
  return Number.isSafeInteger(size) ? size : null
}
