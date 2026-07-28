/**
 * The demo's configuration, read once from the URL.
 *
 * At module scope because it cannot change without a reload, and because `main.tsx` needs
 * it before React renders — the engine is built during render, so a trace sink installed
 * in an effect would miss everything that happens at construction.
 *
 * This is what lets the accuracy suite drive the whole promised matrix against one build.
 * Without it the suite collapsed to a single axis: `scrollPaddingStart` was always 64,
 * `scrollMargin` always 0, the scroller was always the inner element, and the sub-pixel
 * assertion only ever ran for `align: 'start'`.
 */
export interface DemoConfig {
  /** Comment to deep-link to on load. */
  target: number
  paddingStart: number
  scrollMargin: number
  windowScroller: boolean
  /** Load the entire thread, so targets sit deep in a large window. */
  loadAll: boolean
  /** Report each comment at most once, rather than on every re-entry. */
  once: boolean
  /** Collect the library's trace events into a ring buffer readable from the console. */
  trace: boolean
  /** Persist measured sizes to sessionStorage and restore them on the next load. */
  snapshot: boolean
}

export const DEFAULT_HEADER_HEIGHT = 64
export const SNAPSHOT_KEY = 'virtual-anchor-demo-sizes'

import { THREAD_SIZE } from './thread.js'

const params = new URLSearchParams(window.location.search)

const number = (name: string, fallback: number): number => {
  const raw = params.get(name)
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const CONFIG: DemoConfig = {
  target: Math.min(Math.max(number('comment', 0), 0), THREAD_SIZE - 1),
  paddingStart: number('paddingStart', DEFAULT_HEADER_HEIGHT),
  scrollMargin: number('scrollMargin', 0),
  windowScroller: params.get('windowScroller') === '1',
  loadAll: params.get('loadAll') === '1',
  once: params.get('once') === '1',
  trace: params.get('trace') === '1',
  snapshot: params.get('snapshot') === '1',
}
