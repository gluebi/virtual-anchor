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
