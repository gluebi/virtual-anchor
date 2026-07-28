import { devicePixelRatioOf } from './env.js'

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
  /**
   * Screen-space top of the scrollport's *content* area.
   *
   * `getBoundingClientRect().top` is the border-box top, so the container's own
   * border has to be added or every measurement is off by the border width.
   * Learned the hard way: this read a 1px border as a 1px accuracy failure in
   * the residual-carry spike.
   */
  getContentClientTop(): number
  addEventListener(type: 'scroll' | 'scrollend', listener: () => void): () => void
  /** The element measurements and observers should be scoped to. */
  getElement(): HTMLElement | null
  getWindow(): Window | null
  getDevicePixelRatio(): number
}

/** A viewport backed by an element with its own scrollbar. */
export function createElementViewport(element: HTMLElement): Viewport {
  return {
    getScrollOffset: () => element.scrollTop,
    getViewportSize: () => element.clientHeight,
    getMaxScrollOffset: () => Math.max(0, element.scrollHeight - element.clientHeight),
    setScrollOffset: (offset) => {
      element.scrollTop = offset
    },
    getContentClientTop: () => element.getBoundingClientRect().top + element.clientTop,
    addEventListener: (type, listener) => {
      element.addEventListener(type, listener, { passive: true })
      return () => {
        element.removeEventListener(type, listener)
      }
    },
    getElement: () => element,
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
    getMaxScrollOffset: () => Math.max(0, doc.scrollHeight - view.innerHeight),
    setScrollOffset: (offset) => {
      view.scrollTo({ top: offset, behavior: 'auto' })
    },
    // The document's content area starts at the top of the viewport.
    getContentClientTop: () => 0,
    addEventListener: (type, listener) => {
      view.addEventListener(type, listener, { passive: true })
      return () => {
        view.removeEventListener(type, listener)
      }
    },
    getElement: () => doc,
    getWindow: () => view,
    getDevicePixelRatio: () => devicePixelRatioOf(view),
  }
}
