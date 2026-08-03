import type { ItemKey } from './types.js'

/**
 * Everything the library draws, behind one interface.
 *
 * Before this existed, DOM-writing was split three ways with no owner: the engine
 * wrote `scrollTop` and called an injected content-size callback, the scroller wrote
 * `scrollTop` and produced the sub-pixel carry, and the React adapter's layout effect
 * wrote the container height *again*, the carry, and every item's position. The
 * ordering constraint between those writes is real — content size must grow before a
 * scroll offset is written, or the browser clamps it — but half the writes were on
 * the far side of a React commit, so the ordering could only be patched, never
 * guaranteed. The "re-asserting it here" comment in that effect was the tell.
 *
 * Two bugs came directly from the split. The carry was published into store state
 * that the change-detector deliberately ignores, so a carry-only change never
 * triggered the render that would have applied it. And item positions were rounded to
 * device pixels in the adapter while the scroll offset was corrected in the core, so
 * the two roundings cancelled and the carry then broke the cancellation — every
 * landing sat exactly half a pixel off.
 *
 * With one owner, `publish()` writes content size, scroll offset and item positions
 * in a single ordered pass, and there is one place that knows how a position becomes
 * a pixel.
 */
export interface Surface {
  /**
   * Total scrollable content size.
   *
   * Written *before* any scroll offset: after a prepend the restored offset exceeds
   * the old maximum, and a write past it is silently clamped — a several-hundred-pixel
   * jump with nothing logged.
   */
  setContentSize(size: number): void
  /**
   * Empty space held above the items, for `alignToBottom`.
   *
   * A margin on the item container rather than a spacer element, because the
   * container is already a node this owns and its height is already written
   * here — one more style on it costs nothing, where a spacer would need a node
   * in every adapter and a ref to reach it. Margins are refused on *items*
   * because no ResizeObserver box includes them; that argument does not apply to
   * a box whose size this writes rather than measures.
   */
  setLeadingSpace(px: number): void
  /**
   * Sub-pixel paint offset for the whole item container.
   *
   * Recovers the fraction of a pixel the platform refused to take on a scroll write.
   * See {@link createDomSurface} for why this is not a transform.
   */
  setCarry(px: number): void
  /**
   * Paint offset standing in for a scroll write the platform will not accept yet.
   *
   * The same mechanism as {@link setCarry} and deliberately a separate input, because
   * the two answer different questions and compose: the carry is the fraction of a
   * pixel a *completed* write lost, while this is the whole of a correction that has
   * not been written at all. iOS refuses to move the scroll offset during a touch
   * gesture — writing it either cancels the fling or is undone by the gesture's own
   * baseline — so a correction that arrives mid-gesture has to hold the view by moving
   * the content instead, and is folded into `scrollTop` once the gesture ends.
   *
   * Unbounded, unlike the carry: corrections here are routinely hundreds of pixels on
   * a list whose size estimate was fitted at a different viewport width.
   */
  setGestureShift(px: number): void
  /** Position an item. Offsets are exact floats and must not be rounded. */
  setItemOffset(key: ItemKey, offset: number): void
  /** Register an element for a key. Returns its own detach. */
  attachItem(key: ItemKey, element: HTMLElement): () => void
  /** Whether an element is currently attached for this key. */
  hasItem(key: ItemKey): boolean
  /** Move focus to an item, if it is attached. */
  focusItem(key: ItemKey): boolean
  dispose(): void
}

export interface DomSurfaceOptions {
  /**
   * A box holding the element that sizes the content and positions the items.
   *
   * A box rather than the element itself because in React it is attached by a ref
   * callback that can fire after the engine exists — and a box rather than a
   * `getContainer` closure so that no code React analyses during render reads a ref.
   * Deliberately structural (`{ current }`) so the core does not depend on React.
   */
  container: { current: HTMLElement | null }
}

/**
 * A {@link Surface} backed by the DOM.
 *
 * Lives in the core rather than the React adapter so that the adapter is a thin
 * translation layer and a Vue or Svelte adapter would need none of this again.
 */
export function createDomSurface(options: DomSurfaceOptions): Surface {
  const elements = new Map<ItemKey, HTMLElement>()
  /** Last written offset per element, so an unchanged position is not re-written. */
  const writtenOffsets = new WeakMap<HTMLElement, number>()
  /** Elements that have had their invariant styles applied. */
  const styled = new WeakSet<HTMLElement>()

  let lastContentSize: number | null = null
  let lastCarry = 0
  let lastShift = 0
  let lastLeadingSpace = 0

  /**
   * Write the container's paint offset, which two inputs contribute to.
   *
   * Summed in one place because they share a single `top` — two setters writing it
   * independently would each clobber the other's contribution, which is the kind of
   * bug that only shows up when both are non-zero at once: a sub-pixel landing taken
   * mid-gesture.
   *
   * Applied as `top` on the relatively-positioned container for the same antialiasing
   * reason as items.
   */
  const writeContainerOffset = (): void => {
    const total = lastCarry + lastShift
    const container = options.container.current
    if (container) container.style.top = total === 0 ? '' : `${String(-total)}px`
  }

  const position = (element: HTMLElement, offset: number): void => {
    if (!styled.has(element)) {
      styled.add(element)
      // The invariant part, written once per element rather than on every move.
      element.style.position = 'absolute'
      element.style.left = '0'
      element.style.right = '0'
    }

    if (writtenOffsets.get(element) === offset) return
    writtenOffsets.set(element, offset)
    // `top`, not `transform`: a fractional translate disables subpixel text
    // antialiasing in Blink for the whole subtree (crbug 573146), which for
    // text-heavy content is disqualifying. `top` does not layerize.
    //
    // And deliberately *not* snapped to the device pixel grid. Painted position is
    // `itemTop - scrollTop - carry`, which reduces to `itemTop - target` and is
    // therefore exact whatever the platform did to the scroll offset. Rounding here
    // as well is a second compensation for the same problem: the roundings cancel,
    // and then the carry breaks the cancellation.
    element.style.top = `${String(offset)}px`
  }

  return {
    setContentSize(size) {
      if (size === lastContentSize) return
      lastContentSize = size
      const container = options.container.current
      if (container) container.style.height = `${String(size)}px`
    },

    setLeadingSpace(px) {
      if (px === lastLeadingSpace) return
      lastLeadingSpace = px
      const container = options.container.current
      if (container) container.style.marginTop = px === 0 ? '' : `${String(px)}px`
    },

    setCarry(px) {
      if (px === lastCarry) return
      lastCarry = px
      writeContainerOffset()
    },

    setGestureShift(px) {
      if (px === lastShift) return
      lastShift = px
      writeContainerOffset()
    },

    setItemOffset(key, offset) {
      const element = elements.get(key)
      if (element) position(element, offset)
    },

    attachItem(key, element) {
      elements.set(key, element)
      return () => {
        // Only forget it if it is still the element registered for this key: under
        // React's ref semantics a replacement can attach before the old one detaches.
        if (elements.get(key) === element) elements.delete(key)
      }
    },

    hasItem: (key) => elements.has(key),

    focusItem(key) {
      const element = elements.get(key)
      if (!element) return false
      element.focus()
      return true
    },

    dispose() {
      elements.clear()
      lastContentSize = null
      lastCarry = 0
      lastShift = 0
      lastLeadingSpace = 0
    },
  }
}

/** A surface that draws nothing, for tests and non-visual use. */
export function createNullSurface(): Surface {
  return {
    setContentSize: () => {},
    setLeadingSpace: () => {},
    setCarry: () => {},
    setGestureShift: () => {},
    setItemOffset: () => {},
    attachItem: () => () => {},
    hasItem: () => false,
    focusItem: () => false,
    dispose: () => {},
  }
}
