/**
 * Stable identity for an item. Every public API in this library addresses items
 * by key rather than by index, because index-addressed state goes stale the
 * moment the loaded window shifts — which is exactly what bidirectional
 * pagination does on every page load.
 */
export type ItemKey = string | number

/**
 * Where the viewport is, expressed as "this pixel of this item is at the top of
 * the viewport" rather than as a scroll offset.
 *
 * This is the library's source of truth. `scrollTop` is derived from it whenever
 * the layout changes underneath (a prepend, an append, a measurement landing),
 * and the anchor is only re-derived from `scrollTop` in response to genuine user
 * scrolling. That inversion is what makes prepend jump-free and measurement
 * corrections invisible without any compensation heuristics.
 */
export interface Anchor {
  readonly key: ItemKey
  /** Distance in CSS px from the item's own top edge. Never rounded. */
  readonly offsetWithinItem: number
}

/** Where a scroll target should come to rest relative to the viewport. */
export type ScrollAlign = 'start' | 'center' | 'end' | 'auto'

export interface ScrollToOptions {
  align?: ScrollAlign
  /** Extra px added to the resolved target. Negative moves the item down. */
  offset?: number
  behavior?: 'auto' | 'smooth'
}

/**
 * The outcome of a scroll request, resolved once motion has genuinely stopped.
 *
 * `settled: false` is a real, expected outcome — it means convergence hit its
 * deadline, typically because something in the list is resizing continuously.
 * Reporting that honestly (with the leftover `deviation`) is deliberate: the
 * alternative, which every existing library picks, is to claim success and let
 * the caller discover the discrepancy visually.
 */
export interface ScrollResult {
  settled: boolean
  /** Signed px between where the target landed and where it was asked to land. */
  deviation: number
  /** How many measure-and-re-aim rounds the convergence loop needed. */
  iterations: number
}
