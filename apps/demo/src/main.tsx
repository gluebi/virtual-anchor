import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { setTraceSink, type TraceEvent } from 'react-virtual-anchor'
import { App } from './App.js'

/**
 * Tracing is installed here rather than in a component effect.
 *
 * The engine is built during render, so anything it does at construction — restoring a
 * size snapshot, most notably — happens before any effect runs. A sink installed in a
 * layout effect misses exactly the events that are hardest to observe any other way.
 */
if (new URLSearchParams(window.location.search).get('trace') === '1') {
  const buffer: TraceEvent[] = []
  setTraceSink((event) => {
    buffer.push(event)
    if (buffer.length > 3000) buffer.shift()
  })
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
