import type { ItemKey } from './types.js'

/** A batch of measurements delivered together, already deduplicated. */
export type ResizeBatch = readonly (readonly [ItemKey, number])[]

export interface ResizerOptions {
  /** Called with every changed item size from one observer callback. */
  onItemResize: (batch: ResizeBatch) => void
  /**
   * Defer processing to the next animation frame.
   *
   * Escape hatch, off by default. It breaks the same-paint guarantee — a
   * measurement and the corrective scroll write must land in one paint or the
   * viewport visibly jumps and snaps back — so it is only worth reaching for if
   * something downstream mutates layout during measurement.
   */
  useAnimationFrame?: boolean
  /** Warn about item margins in development. See {@link warnAboutMargins}. */
  checkMargins?: boolean
}

export interface Resizer {
  /** Start measuring an item. Returns its own cleanup, for a ref callback. */
  observeItem(element: Element, key: ItemKey): () => void
  /** Read an element's size immediately, without waiting for a callback. */
  measure(element: Element): number
  dispose(): void
}

/**
 * Read an element's size along the block axis.
 *
 * `borderBoxSize` rather than `contentRect`, which excludes padding and border —
 * virtua measures `contentRect`, so a `box-sizing` mismatch there silently
 * corrupts every offset. And never `offsetHeight`, which was historically
 * rounded to whole pixels: ±0.5px per item is ±1000px of drift across 2,000
 * comments, and it forces a wider convergence tolerance to compensate.
 */
function sizeFromEntry(entry: ResizeObserverEntry): number {
  const box = entry.borderBoxSize[0]
  if (box) return box.blockSize
  return entry.target.getBoundingClientRect().height
}

const MARGIN_PROPERTIES = ['marginTop', 'marginBottom'] as const
/** How many items to check before trusting that the contract is respected. */
const MARGIN_CHECK_LIMIT = 5

/**
 * Warn, in development, when an item carries a block-axis margin.
 *
 * No ResizeObserver box includes margins, and margin collapsing between adjacent
 * items is not observable at all — so a margin is silently missing from every
 * offset, and the list drifts by a little more with each item. This is
 * react-virtuoso's single largest support burden; it eventually resorted to
 * parsing `getComputedStyle().rowGap` to cope.
 *
 * The library's answer is a contract — use the `gap` option, not margins — and
 * this check exists so that breaking the contract is a console warning naming
 * the offending item rather than a mysterious accumulating offset.
 */
function warnAboutMargins(element: Element, key: ItemKey): void {
  const view = element.ownerDocument.defaultView
  if (!view) return

  const style = view.getComputedStyle(element)
  for (const property of MARGIN_PROPERTIES) {
    const value = Number.parseFloat(style[property])
    if (Number.isFinite(value) && value !== 0) {
       
      console.warn(
        `[virtual-anchor] item "${String(key)}" has ${property}: ${style[property]}. ` +
          'Item margins are not measurable by ResizeObserver and will make offsets drift. ' +
          'Use the `gap` option for spacing between items instead.',
      )
      return
    }
  }
}

/**
 * One ResizeObserver for the scrollport and every mounted item.
 *
 * Items are bound to their **key**, not their index, via a `WeakMap`. That is
 * what makes prepending free: virtua binds by index and therefore has to
 * re-observe every mounted item whenever the window shifts, and both virtuoso
 * and TanStack read the index back out of a `data-index` DOM attribute, which
 * forces items to be direct children of the measured container and silently
 * measures the wrong row if a consumer forgets the attribute.
 */
export function createResizer(options: ResizerOptions): Resizer {
  const keys = new WeakMap<Element, ItemKey>()
  const lastSizes = new Map<ItemKey, number>()
  let observer: ResizeObserver | null = null
  let disposed = false
  let marginsChecked = 0

  const handle = (entries: readonly ResizeObserverEntry[]): void => {
    if (disposed) return

    const batch: (readonly [ItemKey, number])[] = []

    for (const entry of entries) {
      const target = entry.target

      const key = keys.get(target)
      if (key === undefined) continue

      // A detached node is stale: it reports a zero rect and its key may already
      // belong to a different element. TanStack learned (in #1148) not to look
      // the key up by index here, because the data array may have shrunk since.
      if (!target.isConnected) continue

      // Zero means invisible, not empty: a hidden tab, a `display: none`
      // ancestor, a closed `<details>` or a suspended subtree all measure 0×0.
      // A single zero in the prefix sum collapses the geometry, which makes a
      // scroll target move every frame and the convergence loop never finish.
      const size = sizeFromEntry(entry)
      if (!(size > 0)) continue

      // ResizeObserver always delivers a synthetic first entry for a newly
      // observed element, which duplicates whatever the initial measurement
      // already recorded. Deduplicating by value drops those, and makes
      // StrictMode's double-mount idempotent for free.
      if (lastSizes.get(key) === size) continue

      lastSizes.set(key, size)
      batch.push([key, size])
    }

    // One callback in, one batch out — never one notification per entry.
    if (batch.length > 0) options.onItemResize(batch)
  }

  const callback: ResizeObserverCallback = (entries) => {
    if (options.useAnimationFrame) {
      const view = entries[0]?.target.ownerDocument.defaultView
      if (view) {
        view.requestAnimationFrame(() => {
          handle(entries)
        })
        return
      }
    }
    handle(entries)
  }

  /**
   * Construct lazily, and from the element's *own* window.
   *
   * Lazily so that merely importing the library does not require a DOM, and from
   * `ownerDocument.defaultView` so that a list inside an iframe or a popped-out
   * window observes with that window's ResizeObserver rather than the opener's.
   */
  const ensureObserver = (element: Element): ResizeObserver | null => {
    if (observer) return observer
    const view = element.ownerDocument.defaultView
    if (!view) return null
    observer = new view.ResizeObserver(callback)
    return observer
  }

  return {
    observeItem(element, key) {
      if (disposed) return () => {}

      keys.set(element, key)
      ensureObserver(element)?.observe(element, { box: 'border-box' })

      if (
        options.checkMargins !== false &&
        process.env.NODE_ENV !== 'production' &&
        marginsChecked < MARGIN_CHECK_LIMIT
      ) {
        marginsChecked++
        warnAboutMargins(element, key)
      }

      return () => {
        keys.delete(element)
        lastSizes.delete(key)
        observer?.unobserve(element)
      }
    },

    measure(element) {
      // Synchronous path, for measuring a freshly mounted item before paint.
      // ResizeObserver's first callback arrives *after* the next rendering
      // update, so waiting for it would paint one frame at the wrong offset.
      return element.getBoundingClientRect().height
    },

    dispose() {
      disposed = true
      observer?.disconnect()
      observer = null
      lastSizes.clear()
    },
  }
}
