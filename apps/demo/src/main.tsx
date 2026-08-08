import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { addTraceListener, isTracing, type TraceEvent } from 'virtual-anchor/react'
import { App } from './App.js'
import { CONFIG } from './config.js'

/**
 * Install the diagnostics, then render.
 *
 * The order is load-bearing and the reason this is a function rather than top-level code. The
 * engine is built during render, so anything it does at construction — restoring a size
 * snapshot, most notably — happens before any effect runs, and a listener installed in a layout
 * effect misses exactly the events that are hardest to observe any other way. The `await` for
 * the toolkit therefore has to complete before `createRoot`.
 *
 * The toolkit is a **dynamic** import on purpose, and not only to keep the await local: it means
 * this demo's own build output demonstrates the claim the package makes about
 * `virtual-anchor/debug` — that nobody who does not import it pays for it — rather than the
 * README merely asserting it. Without `?debug=1` the chunk is never fetched.
 */
async function boot(): Promise<void> {
  if (CONFIG.debug) {
    // Failing to load the instrument must not stop the thing being instrumented. This chunk is
    // fetched over the same LAN dev server the whole feature exists to point a phone at, and a
    // 404 or a dropped connection would otherwise leave a blank page and an unhandled rejection
    // instead of a demo without a readout.
    try {
      const { installDebug } = await import('virtual-anchor/debug')
      const session = installDebug({
        // A selector rather than an element: the scrollport does not exist yet, because React
        // has not rendered. The probe resolves it on the first frame that it does.
        target: '.scroller',
        overlay: CONFIG.overlay,
        frameProbe: CONFIG.probe,
        mode: CONFIG.mode,
        capacity: CONFIG.record,
        ...(CONFIG.topics === undefined ? {} : { topics: CONFIG.topics }),
      })

      // Straight off the session's own ring rather than a second buffer of our own. The demo used
      // to keep an array plus `shift()` here *as well*, which meant two full copies of every
      // event during the gesture being measured — and the two could disagree, because the
      // recorder honours a topic filter and a hand-rolled array does not.
      Object.assign(window, {
        __trace: (topic?: string) =>
          session.recorder.select(topic === undefined ? undefined : { topics: [topic] }),
        __traceClear: () => {
          session.recorder.clear()
        },
        __verdict: () => session.verdict(),
        __gestures: () => session.gestures(),
        __traceJSON: () => session.toJSON(),
      })
    } catch (error) {
      console.warn('[demo] could not load virtual-anchor/debug; carrying on without it', error)
    }
  } else if (CONFIG.trace) {
    // `?trace=1` without `?debug=1`: the raw stream and nothing to interpret it, which is what a
    // console session wants. A plain array is the whole tool here.
    const buffer: TraceEvent[] = []
    addTraceListener((event) => {
      buffer.push(event)
      if (buffer.length > CONFIG.record) buffer.shift()
    })
    Object.assign(window, {
      __trace: (topic?: string) =>
        topic === undefined ? buffer : buffer.filter((event) => event.topic.startsWith(topic)),
      __traceClear: () => {
        buffer.length = 0
      },
    })
  }

  if (CONFIG.trace && !isTracing()) {
    console.warn(
      '[demo] tracing is compiled out of this build. Use `pnpm dev`, or ' +
        '`pnpm --filter demo build:trace` for a production build that keeps it.',
    )
  }

  const root = document.getElementById('root')
  if (!root) throw new Error('#root missing')

  // StrictMode deliberately: the double mount is exactly what breaks visibility
  // tracking and observer bookkeeping that lives in effects, so the demo should be
  // running under it at all times rather than only in a test.
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
