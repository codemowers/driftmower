export function poll<T>({ load, receive, fail, interval = 0 }: {
  load: (signal: AbortSignal) => Promise<T>
  receive: (data: T) => void
  fail: (error: unknown) => void
  interval?: number
}): () => void {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  async function tick() {
    try {
      const data = await load(controller.signal)
      if (!controller.signal.aborted) receive(data)
    } catch (error) {
      if (!controller.signal.aborted) fail(error)
    } finally {
      // Schedule after completion so a slow backend never accumulates polls.
      if (!controller.signal.aborted && interval > 0) timer = setTimeout(tick, interval)
    }
  }
  void tick()
  return () => { controller.abort(); clearTimeout(timer) }
}
