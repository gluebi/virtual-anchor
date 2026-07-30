import { createStore, type StoreApi } from 'zustand/vanilla'
import type { ItemKey } from './types.js'

/** One item's position in the list, as handed to the renderer. */
export interface VirtualItem {
  readonly key: ItemKey
  readonly index: number
  /** Top edge in list coordinates. Exact float64, never rounded. */
  readonly start: number
  readonly size: number
  readonly measured: boolean
}

/**
 * The immutable snapshot React reads.
 *
 * Versioned and referentially stable, which is load-bearing rather than tidy.
 * TanStack Virtual avoids `useSyncExternalStore` precisely because its natural
 * snapshot is `getVirtualItems()` — a fresh array on every memo miss, which
 * either tears or trips React's "the result of getSnapshot should be cached"
 * infinite loop. Making the snapshot genuinely immutable is what allows both
 * tear-safety and direct DOM writes.
 */
export interface VirtualState {
  /** Bumped on every mutation, so a change is detectable by identity. */
  readonly version: number
  /** Items to mount: the visible range plus buffer. */
  readonly items: readonly VirtualItem[]
  /** Index range actually mounted, buffer included. */
  readonly renderedRange: readonly [number, number]
  /** Index range genuinely on screen, buffer excluded. */
  readonly visibleRange: readonly [number, number]
  readonly totalSize: number
  readonly scrollOffset: number
  readonly viewportSize: number
  /** Whether a programmatic scroll is in flight. */
  readonly scrolling: boolean
  /**
   * Whether the scroller is at its end, within `atBottomThreshold`.
   *
   * Here rather than derived in a consumer because it has to be read from the
   * viewport at publish time; `totalSize - scrollOffset - viewportSize` looks
   * equivalent and is not, since those three do not share a rounding.
   */
  readonly atBottom: boolean
}

/**
 * The empty index range, shared rather than written out per use.
 *
 * One reference, because the engine hands back *this* tuple for an empty list and a subscriber
 * comparing ranges by identity has to see the empty state and the first empty publish as the same
 * value. Two equal-looking literals would make an empty→empty transition look like a change.
 */
export const EMPTY_RANGE: readonly [number, number] = [0, -1]

export const EMPTY_STATE: VirtualState = {
  version: 0,
  items: [],
  renderedRange: EMPTY_RANGE,
  visibleRange: EMPTY_RANGE,
  totalSize: 0,
  scrollOffset: 0,
  viewportSize: 0,
  scrolling: false,
  // A list with no scroll range has its end on screen, so the honest starting
  // value is `true` — and it is what an empty list keeps reporting.
  atBottom: true,
}

export type VirtualStore = StoreApi<VirtualState>

export function createVirtualStore(): VirtualStore {
  return createStore<VirtualState>(() => EMPTY_STATE)
}

/**
 * Whether two states differ in ways that require React to re-render.
 *
 * Positions are written straight to the DOM, so a scroll that merely moves items
 * within an unchanged mounted set needs no React work at all. This predicate is
 * what turns most scroll frames into zero renders.
 */
export function needsRerender(previous: VirtualState, next: VirtualState): boolean {
  if (previous.renderedRange[0] !== next.renderedRange[0]) return true
  if (previous.renderedRange[1] !== next.renderedRange[1]) return true
  if (previous.scrolling !== next.scrolling) return true
  if (previous.totalSize !== next.totalSize) return true

  // The same range can hold different keys after a prepend.
  if (previous.items.length !== next.items.length) return true
  for (let i = 0; i < next.items.length; i++) {
    if (previous.items[i]?.key !== next.items[i]?.key) return true
  }
  return false
}
