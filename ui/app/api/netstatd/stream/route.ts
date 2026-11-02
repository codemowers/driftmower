import { hasSession } from "@/lib/auth/session"
import { findDescendantPodUids } from "@/lib/features/netstatd/selectors"
import { resolveViewer } from "@/lib/features/netstatd/server/authorize"
import {
  addSubscriber,
  ensureIndex,
  indexBuiltAt,
  removeSubscriber,
  snapshotFor,
  upstreamHealth,
} from "@/lib/features/netstatd/server/hub"
import { normalizeIp } from "@/lib/features/netstatd/server/normalize-ip"
import { encodeFrame, type Subscriber } from "@/lib/features/netstatd/server/subscribe"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const HEARTBEAT_MS = 15_000
const STATUS_MS = 10_000
const MAX_STREAM_MS = 15 * 60 * 1_000

export async function GET(req: Request) {
  if (!(await hasSession())) {
    return Response.json({ error: "unauthenticated" }, { status: 401 })
  }

  const url = new URL(req.url)
  const workloadUid = url.searchParams.get("workload")
  if (!workloadUid) {
    return Response.json({ error: "workload is required" }, { status: 400 })
  }

  const nsParam = url.searchParams.get("ns")
  const selected = nsParam === null ? null : nsParam.split(",").map(s => s.trim()).filter(Boolean)

  let viewer, index
  try {
    ;[viewer, index] = await Promise.all([resolveViewer(selected), ensureIndex()])
  } catch (e) {
    console.error("[netstatd-stream] cannot resolve cluster state:", e)
    return Response.json({ error: "cluster state unavailable" }, { status: 503 })
  }
  if (viewer instanceof Response) return viewer
  const scope = findDescendantPodUids(index.resources, workloadUid)

  const encoder = new TextEncoder()
  let sub: Subscriber | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let status: ReturnType<typeof setInterval> | null = null
  let lifetime: ReturnType<typeof setTimeout> | null = null

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true
      const send = (chunk: string) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          open = false
        }
      }

      const subscriber: Subscriber = {
        scope: {
          podUids: scope.podUids,
          podIPs: new Set([...scope.podIPs].map(normalizeIp).filter(Boolean)),
        },
        viewer,
        conns: new Map(),
        listeningAdded: new Map(),
        listeningRemoved: new Set(),
        write: (event, payload) => send(encodeFrame(event, payload)),
        dropped: 0,
        closed: false,
      }
      sub = subscriber

      function cleanup() {
        if (subscriber.closed) return
        subscriber.closed = true
        open = false
        if (heartbeat) clearInterval(heartbeat)
        if (status) clearInterval(status)
        if (lifetime) clearTimeout(lifetime)
        heartbeat = null
        status = null
        lifetime = null
        removeSubscriber(subscriber)
      }

      function endStream(event: string, payload: unknown) {
        if (subscriber.closed) return
        send(encodeFrame(event, payload))
        cleanup()
        try {
          controller.close()
        } catch {}
      }

      await addSubscriber(subscriber)
      subscriber.write("snapshot", snapshotFor(subscriber))
      subscriber.write("status", { upstream: upstreamHealth(), indexBuiltAt: indexBuiltAt() })

      heartbeat = setInterval(() => send(":hb\n\n"), HEARTBEAT_MS)
      status = setInterval(
        () => subscriber.write("status", { upstream: upstreamHealth(), indexBuiltAt: indexBuiltAt() }),
        STATUS_MS,
      )
      // Authorization is resolved once at connect, so the stream expires to force a re-check.
      lifetime = setTimeout(() => endStream("expired", { reason: "reauthorize" }), MAX_STREAM_MS)

      req.signal.addEventListener("abort", () => {
        cleanup()
        try {
          controller.close()
        } catch {}
      })
    },
    cancel() {
      if (sub && !sub.closed) {
        sub.closed = true
        if (heartbeat) clearInterval(heartbeat)
        if (status) clearInterval(status)
        if (lifetime) clearTimeout(lifetime)
        removeSubscriber(sub)
      }
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}
