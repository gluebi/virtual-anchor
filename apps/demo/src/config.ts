import { THREAD_SIZE } from './thread.js'

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
  /**
   * Height of the measured `header` slot, in px.
   *
   * Replaces the old `scrollMargin` knob, which had to declare the same number
   * twice — once as the option and once as the slot's inline height — and was
   * therefore incapable of testing the case that matters: the two disagreeing.
   * A measured slot has only one number, so the suite exercises the library's
   * own measurement rather than the demo's arithmetic.
   */
  header: number
  /** Height of the measured `footer` slot, in px. */
  footer: number
  /** Height of the measured `stickyFooter` slot, in px. */
  stickyFooter: number
  /** Stay pinned to the newest comment as the thread grows. */
  follow: boolean
  /** Hold a thread too short to scroll against the bottom of the scroller. */
  alignToBottom: boolean
  windowScroller: boolean
  /** Load the entire thread, so targets sit deep in a large window. */
  loadAll: boolean
  /**
   * Open with exactly this many comments from the top, and page no further. 0 for the usual
   * window.
   *
   * The one state the demo could not otherwise reach: a list *short enough not to overflow*.
   * Every other mode opens on 40 comments or the whole thread, so the scroller has had a
   * scrollbar since before the first measurement — which makes the transition into having one
   * unobservable, and that transition is what `stableScrollbarGutter` exists for.
   *
   * Paging is off in this mode rather than merely unlikely: a list with no scroll range is
   * within reach of both its edges at once, so `onEdgeReached` would fire immediately and page
   * the shortness away before anything could look at it.
   */
  loaded: number
  /**
   * Reserve the scrollbar's width in the scrollport. Default on, as the library's is.
   *
   * Here to be turned *off*, so the suite can show what the default prevents rather than only
   * that it is applied.
   */
  stableGutter: boolean
  /** Report each comment at most once, rather than on every re-entry. */
  once: boolean
  /**
   * Which visibility rule to run — see `VisibilityRule` for what `edge` is for.
   *
   * The default stays `fraction` so every other scenario in the suite is unaffected.
   */
  rule: 'fraction' | 'edge'
  /** Collect the library's trace events into a ring buffer readable from the console. */
  trace: boolean
  /** Persist measured sizes to sessionStorage and restore them on the next load. */
  snapshot: boolean
}

export const SNAPSHOT_KEY = 'virtual-anchor-demo-sizes'

/** The demo's sticky header, and so its default `scrollPaddingStart`. */
const DEFAULT_HEADER_HEIGHT = 64

const params = new URLSearchParams(window.location.search)

const number = (name: string, fallback: number): number => {
  const raw = params.get(name)
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const CONFIG: DemoConfig = {
  target: Math.min(Math.max(number('comment', 0), 0), THREAD_SIZE - 1),
  paddingStart: number('paddingStart', DEFAULT_HEADER_HEIGHT),
  header: number('header', 0),
  footer: number('footer', 0),
  stickyFooter: number('stickyFooter', 0),
  follow: params.get('follow') === '1',
  alignToBottom: params.get('alignToBottom') === '1',
  windowScroller: params.get('windowScroller') === '1',
  loadAll: params.get('loadAll') === '1',
  loaded: Math.max(0, number('loaded', 0)),
  stableGutter: params.get('stableGutter') !== '0',
  once: params.get('once') === '1',
  rule: params.get('rule') === 'edge' ? 'edge' : 'fraction',
  trace: params.get('trace') === '1',
  snapshot: params.get('snapshot') === '1',
}

/**
 * Whether the loaded window is decided at load and never moves.
 *
 * Two modes want it for opposite reasons — `loadAll` because there is nothing left to page,
 * `loaded` because paging would undo the state it exists to create — and the three places that
 * page all have to agree, which they did not when only one of the two was spelled at each of
 * them.
 */
export const FIXED_WINDOW = CONFIG.loadAll || CONFIG.loaded > 0
