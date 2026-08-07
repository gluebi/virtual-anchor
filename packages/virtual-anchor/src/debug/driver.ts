/**
 * One `requestAnimationFrame` loop, shared by everything in this module that needs a frame.
 *
 * The frame probe needs a callback per frame to measure gaps, and the overlay needs one to
 * coalesce its repaints. Two independent loops would be two main-thread wakeups per frame
 * *during the fling being diagnosed* — and the thing being diagnosed is main-thread
 * contention, so an instrument that doubles its own wakeups is measuring itself.
 *
 * Refcounted rather than started eagerly: the loop runs only while something is subscribed,
 * and stops on the last unsubscribe. Nothing here reads the DOM.
 */

export interface FrameDriver {
  /** Subscribe to every frame. Returns an unsubscribe. */
  onFrame(callback: (at: number, gap: number) => void): () => void
  /** Whether the loop is currently running. */
  running(): boolean
}

/**
 * The driver for a window, created on demand.
 *
 * Per-window rather than a module singleton because a consumer may run a list inside an
 * iframe or a popout, and `requestAnimationFrame` on the wrong window fires against the
 * wrong compositor — which for a frame-timing probe is not a detail.
 */
export function createFrameDriver(view: Window = globalThis.window): FrameDriver {
  const callbacks = new Set<(at: number, gap: number) => void>()
  let handle: number | null = null
  let last = 0

  const tick = (at: number): void => {
    handle = null
    // Before the callbacks, so a callback that subscribes or unsubscribes cannot make the
    // loop stop when it should continue.
    if (callbacks.size > 0) handle = view.requestAnimationFrame(tick)

    const gap = last === 0 ? 0 : at - last
    last = at
    // A copy, so a callback removing itself does not skip the one behind it — the same
    // reasoning as the trace fan-out, and the same reason it is not wrapped in a `try`.
    for (const callback of [...callbacks]) callback(at, gap)
  }

  const start = (): void => {
    if (handle !== null) return
    last = 0
    handle = view.requestAnimationFrame(tick)
  }

  const stop = (): void => {
    if (handle === null) return
    view.cancelAnimationFrame(handle)
    handle = null
  }

  return {
    onFrame(callback) {
      callbacks.add(callback)
      start()
      return () => {
        callbacks.delete(callback)
        if (callbacks.size === 0) stop()
      }
    },
    running: () => handle !== null,
  }
}
