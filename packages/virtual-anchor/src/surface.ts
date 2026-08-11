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
   * Empty space held *below* the items, so a sticky footer reaches the bottom edge.
   *
   * `position: sticky; bottom: 0` lifts a box to an edge and can never push one down
   * to one, so on a list too short to fill the scrollport the slot rests at its static
   * position — the end of the items — and the documented pin is a pin to nothing. This
   * is the space that moves that static position onto the edge.
   *
   * The mirror of {@link setLeadingSpace} in intent, but **padding rather than a
   * margin**, and not for symmetry's sake either way. Whatever follows the container —
   * the `footer` wrapper, or the sticky one when there is no footer — is an adjacent
   * sibling, and adjacent siblings' margins collapse: a consumer's own margin on that
   * wrapper would take the max of the two rather than the sum, leaving the composer
   * short of the edge by their margin. Padding cannot collapse with anything.
   *
   * The reason {@link setLeadingSpace} cannot have the same treatment, despite the same
   * exposure: items are absolutely positioned against the container's *padding* box, and
   * `padding-top` does not move that box's top edge. It would grow the container without
   * moving a single item, which is the whole of what leading space is for. The same fact
   * is what makes `padding-bottom` right here — space below the items that leaves them
   * exactly where they are.
   */
  setTrailingSpace(px: number): void
  /**
   * Paint offset for the whole item container, in px. Positive moves content up.
   *
   * Two things arrive here, summed by the engine because both are its arithmetic: the
   * fraction of a pixel the platform refused on a scroll write, and — on iOS, which
   * will not move the scroll offset during a touch gesture at all — the whole of a
   * correction that could not be written yet. Hence "paint offset" rather than "carry":
   * the second contributor is routinely hundreds of pixels.
   *
   * See {@link createDomSurface} for why this is not a transform.
   */
  setPaintOffset(px: number): void
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
  let lastPaintOffset = 0
  let lastLeadingSpace = 0
  let lastTrailingSpace = 0

  /**
   * The container's invariant styles, written once on first sight of it.
   *
   * Only `box-sizing`, and it has to be stated rather than inherited: `setTrailingSpace`
   * holds its space as padding, and under the `* { box-sizing: border-box }` reset almost
   * every app carries — the demo included — that padding would come *out of* the height
   * written here instead of adding to it, and a sticky footer would not move a pixel.
   *
   * Unconditional rather than written alongside the padding, because a box model that
   * flipped the moment a composer mounted would reinterpret the `height` this already
   * writes, at that instant, for every list that has one. Through the same `styled` set
   * the items use, so a container swapped through the ref box is styled again.
   */
  const styleContainer = (container: HTMLElement): void => {
    if (styled.has(container)) return
    styled.add(container)
    container.style.boxSizing = 'content-box'
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
      if (!container) return
      // Before the height, which is the style the box model reinterprets.
      styleContainer(container)
      container.style.height = `${String(size)}px`
    },

    setLeadingSpace(px) {
      if (px === lastLeadingSpace) return
      lastLeadingSpace = px
      const container = options.container.current
      if (container) container.style.marginTop = px === 0 ? '' : `${String(px)}px`
    },

    setTrailingSpace(px) {
      if (px === lastTrailingSpace) return
      lastTrailingSpace = px
      const container = options.container.current
      if (!container) return
      styleContainer(container)
      container.style.paddingBottom = px === 0 ? '' : `${String(px)}px`
    },

    setPaintOffset(px) {
      if (px === lastPaintOffset) return
      lastPaintOffset = px
      const container = options.container.current
      // Applied as `top` on the relatively-positioned container for the same
      // antialiasing reason as items.
      if (container) container.style.top = px === 0 ? '' : `${String(-px)}px`
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
      lastPaintOffset = 0
      lastLeadingSpace = 0
      lastTrailingSpace = 0
    },
  }
}

/** A surface that draws nothing, for tests and non-visual use. */
export function createNullSurface(): Surface {
  return {
    setContentSize: () => {},
    setLeadingSpace: () => {},
    setTrailingSpace: () => {},
    setPaintOffset: () => {},
    setItemOffset: () => {},
    attachItem: () => () => {},
    hasItem: () => false,
    focusItem: () => false,
    dispose: () => {},
  }
}
