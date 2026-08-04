import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setTraceSink, type TraceEvent } from 'virtual-anchor/react'
import { App } from './App.js'
import { CONFIG } from './config.js'

/**
 * Tracing is installed here rather than in a component effect.
 *
 * The engine is built during render, so anything it does at construction — restoring a
 * size snapshot, most notably — happens before any effect runs. A sink installed in a
 * layout effect misses exactly the events that are hardest to observe any other way.
 */
if (CONFIG.trace) {
  const buffer: TraceEvent[] = []
  // `setTraceSink` reports whether this build has tracing at all: a production bundle
  // compiles it out, which is the point. Saying so beats exposing a `__trace` that always
  // returns an empty array and looks like a bug in the library.
  const installed = setTraceSink((event) => {
    buffer.push(event)
    if (buffer.length > 3000) buffer.shift()
  })
  if (!installed) {
    console.warn('[demo] tracing is compiled out of this build; run `pnpm dev` for it')
  }
  Object.assign(window, {
    __trace: (topic?: string) =>
      topic === undefined ? buffer : buffer.filter((event) => event.topic.startsWith(topic)),
    __traceClear: () => {
      buffer.length = 0
    },
  })

  /**
   * A plain DOM overlay of the last few scroll corrections.
   *
   * Deliberately not React: it updates on every correction, and re-rendering the app to
   * show diagnostics would change the very thing being diagnosed. Written straight to
   * the DOM outside the root, so it costs the list nothing.
   */
  if (CONFIG.hud) {
    const hud = document.createElement('div')
    hud.style.cssText = [
      'position:fixed',
      'left:0',
      'right:0',
      'bottom:0',
      'z-index:9999',
      'background:rgba(0,0,0,.82)',
      'color:#0f0',
      'font:11px/1.35 ui-monospace,monospace',
      'padding:6px 8px',
      'white-space:pre',
      'pointer-events:none',
      'max-height:38vh',
      'overflow:hidden',
    ].join(';')
    document.body.appendChild(hud)

    const lines: string[] = []
    let taken = 0
    let deferredCount = 0
    let worst = 0
    let held = 0

    setTraceSink((event) => {
      buffer.push(event)
      if (buffer.length > 3000) buffer.shift()
      if (event.topic !== 'scroll.write') return

      const delta = Number(event.data.delta)
      const deferred = event.data.deferred === true
      if (deferred) deferredCount++
      else taken++
      if (Math.abs(delta) > Math.abs(worst)) worst = delta
      held = deferred ? Number(event.data.pendingShift) + delta : 0

      // A write that happened *while* a gesture wanted it deferred is the bound firing —
      // the one thing that still cancels momentum, and worth naming rather than leaving
      // to be inferred from a WRITE among DEFERs.
      const label = deferred ? 'DEFER' : 'WRITE'
      lines.unshift(
        `${label} ${String(event.data.restore).padEnd(7)} ` +
          `Δ${delta.toFixed(1).padStart(9)}  room ${Number(event.data.room ?? 0).toFixed(0)}`,
      )
      if (lines.length > 10) lines.pop()
      hud.textContent =
        `writes ${String(taken)}  deferred ${String(deferredCount)}  ` +
        `worst Δ ${worst.toFixed(1)}  held ${held.toFixed(0)}\n` +
        lines.join('\n')
    })
    Object.assign(window, {
      __hudReset: () => {
        lines.length = 0
        taken = 0
        deferredCount = 0
        worst = 0
        held = 0
        hud.textContent = 'reset'
      },
    })
  }
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
