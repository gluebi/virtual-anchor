/**
 * Whether the scroller itself is actually on screen right now.
 *
 * Per-item visibility is computed from the size cache and the scroll offset,
 * which is exact, synchronous and free of observer churn — but completely blind
 * to its own ancestors. It will happily report a comment as fully visible while
 * the scroller sits inside a collapsed `<details>`, is scrolled off the page, has
 * been `display: none`d by a tab switch, or is in a background browser tab.
 *
 * This supplies that missing knowledge at **constant cost** regardless of item
 * count: one IntersectionObserver with one target, one ResizeObserver with one
 * target, and one `visibilitychange` listener. The alternative — an
 * IntersectionObserver per item — pays per row for information that is identical
 * for all of them.
 */
export interface ScrollerGate {
  /** Whether items may currently be reported as visible at all. */
  isOpen(): boolean
  /**
   * The portion of the scrollport actually on screen, in scroller-relative px,
   * or null when it is entirely hidden.
   *
   * A half-off-screen scroller is the case neither pure geometry nor a plain
   * "is it intersecting" boolean gets right: geometry thinks the whole viewport
   * is visible, and the boolean says "yes, visible". Intersecting the reported
   * band with this range makes per-item visibility correct even then.
   */
  getVisibleBand(): { start: number; end: number } | null
  dispose(): void
}

export interface ScrollerGateOptions {
  /** The scrollport element to watch. */
  element: HTMLElement
  /** Called whenever the gate's answer changes, so a sample can be re-run. */
  onChange?: () => void
}

const CLOSED = { open: false, band: null } as const

export function createScrollerGate(options: ScrollerGateOptions): ScrollerGate {
  const { element, onChange } = options
  const view = element.ownerDocument.defaultView
  const doc = element.ownerDocument

  let intersecting = true
  /** Intersection rect in scroller-relative coordinates, null when hidden. */
  let band: { start: number; end: number } | null = null
  let hasSize = true
  let documentVisible = doc.visibilityState !== 'hidden'
  let disposed = false

  const notify = (): void => {
    if (!disposed) onChange?.()
  }

  const cleanups: Array<() => void> = []

  if (view) {
    // `root: null` deliberately — the question is "is this on screen", and only
    // the viewport can answer it. Using the scroller as its own root would
    // always say yes.
    const observer = new view.IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        if (!entry) return

        intersecting = entry.isIntersecting
        if (!entry.isIntersecting) {
          band = null
        } else {
          // Convert the on-screen slice into offsets within the scrollport, so
          // the caller can narrow the reported band to it.
          const bounds = entry.boundingClientRect
          const visible = entry.intersectionRect
          band = {
            start: Math.max(0, visible.top - bounds.top),
            end: Math.max(0, visible.bottom - bounds.top),
          }
        }
        notify()
      },
      { root: null, threshold: [0] },
    )
    observer.observe(element)
    cleanups.push(() => {
      observer.disconnect()
    })

    const resizeObserver = new view.ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (!entry) return
      const box = entry.borderBoxSize[0]
      hasSize = (box ? box.blockSize : entry.contentRect.height) > 0
      notify()
    })
    resizeObserver.observe(element, { box: 'border-box' })
    cleanups.push(() => {
      resizeObserver.disconnect()
    })
  }

  const onDocumentVisibility = (): void => {
    documentVisible = doc.visibilityState !== 'hidden'
    notify()
  }
  doc.addEventListener('visibilitychange', onDocumentVisibility)
  cleanups.push(() => {
    doc.removeEventListener('visibilitychange', onDocumentVisibility)
  })

  const state = (): { open: boolean; band: { start: number; end: number } | null } => {
    if (disposed) return CLOSED
    if (!documentVisible || !hasSize || !intersecting) return CLOSED
    return { open: true, band }
  }

  return {
    isOpen: () => state().open,
    getVisibleBand: () => state().band,
    dispose() {
      disposed = true
      for (const cleanup of cleanups) cleanup()
      cleanups.length = 0
    },
  }
}
