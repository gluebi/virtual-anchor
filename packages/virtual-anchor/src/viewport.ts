import { devicePixelRatioOf } from './env.js'

/**
 * The element a document actually scrolls.
 *
 * `documentElement` in standards mode and `body` in quirks mode, which is what
 * `scrollingElement` exists to tell you. Exported because three places used to answer this
 * question separately and disagreed: the window viewport clamped against
 * `documentElement.scrollHeight`, the React adapter fingerprinted the layout from
 * `documentElement`, and `VirtualList` handed `scrollingElement` to `scrollerRef`. In standards
 * mode all three coincide, so the disagreement was invisible — and wrong in quirks mode, where
 * `documentElement.scrollHeight` is not the page's scroll extent at all.
 *
 * Narrowed with `instanceof` rather than asserted: the property is typed `Element | null` and
 * really is null on a document with no browsing context.
 */
export function documentScrollElement(view: Window): HTMLElement {
  const scrolling = view.document.scrollingElement
  return scrolling instanceof HTMLElement ? scrolling : view.document.documentElement
}

/**
 * A scroll container, whether that is an element with `overflow: auto` or the
 * document itself.
 *
 * Everything downstream reads and writes scroll position through this one
 * interface so that no other module has to branch on which kind it is — and,
 * more importantly, so that the coordinate space is decided in exactly one
 * place. Mixing the two spaces is the whole of TanStack #1001, where clamping
 * against the wrong extent made the error grow with the list's distance from the
 * top of the page.
 */
export interface Viewport {
  /** Current scroll offset along the scrolling axis, in CSS px. */
  getScrollOffset(): number
  /** Visible extent along the scrolling axis, excluding borders. */
  getViewportSize(): number
  /**
   * The browser's own maximum scroll offset.
   *
   * Read from the DOM rather than derived from the size cache. Clamping a scroll
   * target against our *estimated* total is precisely the bug in TanStack #1001:
   * the estimate is not the document, and the discrepancy grows with the amount
   * of content outside the list.
   */
  getMaxScrollOffset(): number
  /** Write the scroll offset. Fractional values are passed through as-is. */
  setScrollOffset(offset: number): void
  addEventListener(type: 'scroll' | 'scrollend', listener: () => void): () => void
  /**
   * The element items are measured against and input listeners attach to.
   *
   * For a document scroller this is `documentElement`, which is emphatically *not* the
   * thing whose size equals {@link getViewportSize} — see {@link observeSize}.
   */
  getElement(): HTMLElement | null
  /**
   * The element that scrolls — the scrollport itself.
   *
   * Distinct from {@link getElement} on purpose. That one is the measurement and input scope,
   * which for a document scroller is `documentElement` and must stay so; this one is the node
   * that actually scrolls, which in quirks mode is `body`. They coincide in standards mode.
   *
   * This is what a consumer should be handed when it asks for the scroller, and what the layout
   * fingerprint is taken from, since it is the scrollport's width that decides how text wraps.
   */
  getScrollportElement(): HTMLElement | null
  /**
   * Observe changes to the *scrollport's* size.
   *
   * A `Viewport` concern rather than the engine's, because only the viewport knows what
   * to watch. Getting this wrong was a critical bug: the engine observed
   * `getElement()`, and for a document scroller that is `documentElement`, whose
   * border-box height is the **content** height. So every content growth looked like a
   * viewport resize, the engine read it as a reflow and discarded the whole measurement
   * cache — a window-scrolled list erased its own measurement history as it scrolled
   * and ran permanently on estimates.
   */
  observeSize(onResize: (size: number) => void): () => void
  /**
   * The element an on-screen check should observe, or null if the scrollport *is* the
   * screen and no check is meaningful.
   */
  getGateTarget(): HTMLElement | null
  getWindow(): Window | null
  getDevicePixelRatio(): number
}

/**
 * The scrollport's content height, as a float.
 *
 * `clientHeight` is an *integer*: a scrollport 634.5px tall reports 635. Every other number
 * in this library is exact float64, and alignment arithmetic is built from this one — so that
 * rounding leaked straight into a landing, putting an `align: 'end'` target half a pixel
 * below the visible bottom on any scrollport with a fractional height. Which is most of them:
 * a flex layout with a wrapping sticky header above it produces one immediately.
 *
 * `offsetHeight - clientHeight` is the integer part that `getBoundingClientRect` includes and
 * `clientHeight` does not — the horizontal borders plus a horizontal scrollbar if there is
 * one. Subtracting it from the exact box height leaves the exact content height.
 */
function contentHeightOf(element: HTMLElement): number {
  const chrome = element.offsetHeight - element.clientHeight
  return Math.max(0, element.getBoundingClientRect().height - chrome)
}

/** A viewport backed by an element with its own scrollbar. */
export function createElementViewport(element: HTMLElement): Viewport {
  return {
    getScrollOffset: () => element.scrollTop,
    getViewportSize: () => contentHeightOf(element),
    getMaxScrollOffset: () => Math.max(0, element.scrollHeight - element.clientHeight),
    setScrollOffset: (offset) => {
      element.scrollTop = offset
    },
    addEventListener: (type, listener) => {
      element.addEventListener(type, listener, { passive: true })
      return () => {
        element.removeEventListener(type, listener)
      }
    },
    getElement: () => element,
    // An element scroller's own box *is* the scrollport, so a ResizeObserver on it is
    // exactly right — and it is also the thing that can be scrolled off screen.
    observeSize(onResize) {
      const view = element.ownerDocument.defaultView
      if (!view) return () => {}

      /**
       * The last border box delivered, so a delivery that changed nothing is dropped.
       *
       * Both axes, because `observe(element, { box: 'border-box' })` delivers on either
       * and a consumer reads any resize as "the layout may have changed" — which it
       * answers by re-reading a fingerprint of the scrollport's *width*, the thing that
       * decides where text wraps. Comparing the block size alone therefore swallowed
       * exactly the deliveries that mattered: a scrollport that changed width without
       * changing height kept every row height measured under the old width (#34).
       *
       * The first delivery is forwarded, since there is nothing yet to compare it
       * against. Not reading *that* one as a change is the consumer's job — one frame
       * after mount it looks like the scrollport resizing, and a consumer that reads a
       * resize as a reflow discards every measurement it has, including any restored from
       * a snapshot. That is how the whole `sizeSnapshot` feature came to do nothing.
       */
      let last: { block: number; inline: number } | null = null

      const observer = new view.ResizeObserver((entries) => {
        const entry = entries[entries.length - 1]
        if (!entry) return
        const box = entry.borderBoxSize[0]
        const block = box ? box.blockSize : entry.contentRect.height
        const inline = box ? box.inlineSize : entry.contentRect.width
        // A null `last` compares unequal on the first term, which is the first delivery
        // going through. Written as an optional chain because eslint asks for one here.
        if (last?.block === block && last.inline === inline) return
        last = { block, inline }
        onResize(block)
      })
      observer.observe(element, { box: 'border-box' })
      return () => {
        observer.disconnect()
      }
    },
    getGateTarget: () => element,
    // The element is both the measurement scope and the thing that scrolls.
    getScrollportElement: () => element,
    getWindow: () => element.ownerDocument.defaultView,
    getDevicePixelRatio: () => devicePixelRatioOf(element.ownerDocument.defaultView),
  }
}

/**
 * A viewport backed by the document scroller.
 *
 * Note the asymmetry the platform forces here: scroll offset comes from the
 * window, the scrollable extent from the documentElement, and the visible size
 * from `innerHeight` rather than `clientHeight` so that mobile URL-bar
 * behaviour is accounted for.
 */
export function createWindowViewport(view: Window): Viewport {
  const doc = view.document.documentElement

  return {
    getScrollOffset: () => view.scrollY,
    getViewportSize: () => view.innerHeight,
    // Through the resolver, not `doc`: in quirks mode `documentElement.scrollHeight` is not the
    // page's scroll extent, so clamping against it is the TanStack #1001 failure this interface's
    // own doc warns about. Resolved per call rather than captured, since `body` may not exist yet
    // when a viewport is constructed.
    getMaxScrollOffset: () =>
      Math.max(0, documentScrollElement(view).scrollHeight - view.innerHeight),
    setScrollOffset: (offset) => {
      view.scrollTo({ top: offset, behavior: 'auto' })
    },
    // The scrollport is the window, so its size comes from `resize` (and from
    // visualViewport, which is what actually changes when a mobile URL bar or a soft
    // keyboard appears). Observing `documentElement` here would report the content
    // height instead.
    observeSize(onResize) {
      const report = (): void => {
        onResize(view.innerHeight)
      }
      view.addEventListener('resize', report, { passive: true })
      view.visualViewport?.addEventListener('resize', report, { passive: true })
      return () => {
        view.removeEventListener('resize', report)
        view.visualViewport?.removeEventListener('resize', report)
      }
    },
    // A window scroller cannot be scrolled off screen: it *is* the screen. There is
    // nothing to gate on beyond document visibility, which the gate handles itself.
    getGateTarget: () => null,
    addEventListener: (type, listener) => {
      view.addEventListener(type, listener, { passive: true })
      return () => {
        view.removeEventListener(type, listener)
      }
    },
    getElement: () => doc,
    getScrollportElement: () => documentScrollElement(view),
    getWindow: () => view,
    getDevicePixelRatio: () => devicePixelRatioOf(view),
  }
}
