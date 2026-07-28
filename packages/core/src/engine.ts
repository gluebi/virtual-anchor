import { deriveAnchor, offsetForIndex, resolveAnchorOffset } from './anchor.js'
import { type Band, ListGeometry, type ListInsets } from './listGeometry.js'
import { createScrollerGate, type ScrollerGate } from './gate.js'
import { createResizer, type Resizer } from './resizer.js'
import { createScroller, type Scroller } from './scroller.js'
import { SizeCache, type SizeSnapshot } from './sizeCache.js'
import { createVirtualStore, type VirtualItem, type VirtualState, type VirtualStore } from './store.js'
import type { Anchor, ItemKey, ScrollResult, ScrollToOptions } from './types.js'
import type { Viewport } from './viewport.js'
import {
  VisibilityTracker,
  type VisibilityCandidate,
  type VisibilityEvent,
  type VisibilityOptions,
} from './visibility.js'

export interface EngineOptions {
  viewport: Viewport
  /** The loaded window, in display order. A stable reference is a no-op. */
  keys: readonly ItemKey[]
  estimateSize?: (index: number, key: ItemKey) => number
  defaultEstimate?: number
  gap?: number
  /** Extra px of items mounted beyond the viewport, in each direction. */
  buffer?: number
  geometry?: ListInsets
  /** Keys always kept mounted, e.g. whatever currently holds focus. */
  keepMounted?: readonly ItemKey[]
  visibility?: VisibilityOptions
  onVisibilityChange?: (events: VisibilityEvent[]) => void
  sizeSnapshot?: SizeSnapshot
  /** Identifies the layout a size snapshot was measured in. */
  layoutSignature?: string
  /**
   * Write the total content height to the DOM.
   *
   * The engine calls this *before* it writes a scroll offset, and the ordering is
   * not incidental: a prepend grows the content and moves the anchored item down,
   * so the restored offset is larger than the old maximum. Written while the
   * container is still its old height, the browser clamps it — and the view ends
   * up hundreds of pixels adrift with no error anywhere. Owning the order here
   * rather than leaving it to a layout effect is what makes it correct.
   */
  setContentSize?: (size: number) => void
  now?: () => number
}

export interface Engine {
  readonly store: VirtualStore
  readonly cache: SizeCache
  setOptions(options: Partial<EngineOptions>): void
  /** Attach the scrollport. Returns its own teardown. */
  mount(): () => void
  observeItem(element: Element, key: ItemKey): () => void
  scrollToKey(key: ItemKey, options?: ScrollToOptions): Promise<ScrollResult>
  scrollToIndex(index: number, options?: ScrollToOptions): Promise<ScrollResult>
  getAnchor(): Anchor | null
  setAnchor(anchor: Anchor): void
  takeSizeSnapshot(): SizeSnapshot
  getVisibility(key: ItemKey): ReturnType<VisibilityTracker['get']>
  subscribeVisibility(key: ItemKey, listener: () => void): () => void
  dispose(): void
}

const DEFAULT_BUFFER = 400

/**
 * Wires the cache, anchor, resizer, scroller, visibility tracker and gate into
 * one object, and owns the single rule that makes the whole thing work:
 * **`scrollTop` is derived from the anchor whenever the layout changes.**
 */
export function createEngine(initial: EngineOptions): Engine {
  let options: EngineOptions = initial
  const now = (): number => options.now?.() ?? performance.now()

  const cache = new SizeCache({
    keys: options.keys,
    ...(options.gap === undefined ? {} : { gap: options.gap }),
    ...(options.estimateSize === undefined ? {} : { estimateSize: options.estimateSize }),
    ...(options.defaultEstimate === undefined
      ? {}
      : { defaultEstimate: options.defaultEstimate }),
    ...(options.layoutSignature === undefined
      ? {}
      : { layoutSignature: options.layoutSignature }),
    ...(options.sizeSnapshot === undefined ? {} : { snapshot: options.sizeSnapshot }),
  })

  const store = createVirtualStore()
  const tracker = new VisibilityTracker(options.visibility ?? {})
  const visibilityListeners = new Map<ItemKey, Set<() => void>>()

  /** The position of record. Everything else is derived from it. */
  let anchor: Anchor | null = null
  /**
   * Set while this module is writing `scrollTop` from the anchor.
   *
   * The resulting scroll event must not re-derive the anchor: we would be reading
   * back a value the platform may have snapped, so the in-item offset would drift
   * by a fraction of a pixel on every correction. Every *other* scroll — the
   * user's, and the scroller's own — should update the anchor, because those move
   * the view intentionally and the anchor's job is to record where the view is.
   */
  let restoringScroll = false
  let carry = 0
  let gate: ScrollerGate | null = null
  let disposed = false

  const viewport = options.viewport
  /**
   * The single owner of scroller-space ↔ list-space conversion.
   *
   * Re-synced from the live options and viewport rather than rebuilt, so every
   * caller in this file necessarily agrees about where the visible area is. The
   * band arithmetic it replaces was written out twice here — once for the rendered
   * range and once for the visibility sample — and had to be kept in step by hand.
   */
  const listGeometry = new ListGeometry()
  const geometry = (): ListInsets => options.geometry ?? {}
  const syncGeometry = (): ListGeometry => {
    listGeometry.update(geometry(), viewport.getViewportSize())
    return listGeometry
  }

  const notifyVisibility = (events: VisibilityEvent[]): void => {
    if (events.length === 0) return
    for (const event of events) {
      const listeners = visibilityListeners.get(event.key)
      if (listeners) for (const listener of listeners) listener()
    }
    options.onVisibilityChange?.(events)
  }

  /** Items to mount: everything within the viewport plus the buffer. */
  const computeRanges = (
    scrollOffset: number,
  ): { rendered: [number, number]; visible: [number, number] } => {
    if (cache.length === 0) return { rendered: [0, -1], visible: [0, -1] }

    const g = syncGeometry()
    const visible = g.visibleBand(scrollOffset)
    const buffered = g.bufferedBand(scrollOffset, options.buffer ?? DEFAULT_BUFFER)

    return {
      rendered: [cache.indexAt(buffered.start), cache.indexAt(buffered.end)],
      visible: [cache.indexAt(visible.start), cache.indexAt(Math.max(visible.start, visible.end))],
    }
  }

  const itemsFor = (range: readonly [number, number]): VirtualItem[] => {
    const items: VirtualItem[] = []
    for (let index = range[0]; index <= range[1]; index++) {
      const key = cache.keyAt(index)
      if (key === undefined) continue
      items.push({
        key,
        index,
        start: cache.offsetOf(index),
        size: cache.sizeOf(index),
        measured: cache.isMeasured(index),
      })
    }

    // Anything explicitly pinned — normally whatever holds focus — is mounted
    // even when far outside the range, so tabbing out of a recycled row does not
    // drop focus to the body.
    for (const key of options.keepMounted ?? []) {
      const index = cache.indexOf(key)
      if (index < 0 || (index >= range[0] && index <= range[1])) continue
      items.push({
        key,
        index,
        start: cache.offsetOf(index),
        size: cache.sizeOf(index),
        measured: cache.isMeasured(index),
      })
    }

    return items.sort((a, b) => a.index - b.index)
  }

  /**
   * Recompute everything from the anchor and publish a new snapshot.
   *
   * `restoreScroll` is the crux: when the layout changed underneath — a prepend,
   * an append, a measurement landing — the scroll offset is re-derived from the
   * anchor rather than patched with a delta. That is what makes the correction
   * invisible, and it is why there is no compensation heuristic anywhere in this
   * file.
   */
  const publish = (restoreScroll: boolean): void => {
    if (disposed) return

    // Grow (or shrink) the content *first*. A restored offset after a prepend is
    // larger than the old maximum, and the browser silently clamps a write that
    // exceeds it.
    const totalSize = cache.totalSize()
    options.setContentSize?.(totalSize)

    // The anchor keeps the *user's* position stable. While a programmatic scroll
    // is in flight the scroller is authoritative instead — restoring an anchor
    // captured before it started would drag the view back and stall convergence.
    if (restoreScroll && anchor && !scroller.isScrolling()) {
      const restored = resolveAnchorOffset(anchor, cache, geometry())
      // A null restore means the anchored key left the window. For a grows-only
      // window that cannot happen; if it does, holding position beats jumping.
      if (restored !== null && Math.abs(restored - viewport.getScrollOffset()) > 0.01) {
        // Declare it first: the scroll event this produces must not be mistaken
        // for the user grabbing the scrollbar, which would cancel any in-flight
        // programmatic scroll and flip the tracked scroll direction.
        scroller.markSelfWrite(restored)
        restoringScroll = true
        viewport.setScrollOffset(restored)
        restoringScroll = false
      }
    }

    const scrollOffset = viewport.getScrollOffset()
    const ranges = computeRanges(scrollOffset)
    const items = itemsFor(ranges.rendered)
    const previous = store.getState()

    store.setState({
      version: previous.version + 1,
      items,
      renderedRange: ranges.rendered,
      visibleRange: ranges.visible,
      totalSize,
      carry,
      scrollOffset,
      viewportSize: viewport.getViewportSize(),
      scrolling: scroller.isScrolling(),
    })

    sampleVisibility(ranges.visible, scrollOffset)
  }

  const sampleVisibility = (
    visible: readonly [number, number],
    scrollOffset: number,
  ): void => {
    const g = syncGeometry()

    // Narrow to the part of the scrollport genuinely on screen, so a half
    // off-screen scroller does not report its hidden half as visible. The
    // conversion from the gate's scrollport-relative band into list coordinates is
    // `ListGeometry`'s job: doing it here by hand, in a second place, is what let
    // the document scroller apply its offset twice.
    const band = g.clampToOnScreen(scrollOffset, g.visibleBand(scrollOffset), gate?.getVisibleBand() ?? null)
    if (band === null) {
      notifyVisibility(tracker.flushLeaves(now()))
      return
    }
    const { start, end } = band

    const candidates: VisibilityCandidate[] = []
    // Sample a little beyond the visible range so an item leaving is seen
    // transitioning rather than vanishing.
    const from = Math.max(0, visible[0] - 1)
    const to = Math.min(cache.length - 1, visible[1] + 1)
    for (let index = from; index <= to; index++) {
      const key = cache.keyAt(index)
      if (key === undefined) continue
      candidates.push({
        index,
        key,
        start: cache.offsetOf(index),
        size: cache.sizeOf(index),
        measured: cache.isMeasured(index),
      })
    }

    notifyVisibility(
      tracker.sample({
        viewportStart: start,
        viewportEnd: end,
        items: candidates,
        now: now(),
        gated: gate?.isOpen() ?? true,
        suppressed: scroller.isScrolling(),
      }),
    )
  }

  const resizer: Resizer = createResizer({
    onItemResize(batch) {
      let changed = false
      for (const [key, size] of batch) {
        const index = cache.indexOf(key)
        if (index < 0) continue
        if (cache.setSize(index, size)) changed = true
      }
      if (!changed) return

      cache.refreshEstimate(viewport.getViewportSize())
      // Re-derive the scroll offset from the anchor: the item that was under the
      // viewport top stays under the viewport top, whatever moved above it.
      publish(true)
      scroller.notifyMeasured()
    },
    onViewportResize() {
      // A viewport width change reflows every comment, so all measurements are
      // stale. Heights are static per layout, not across layouts.
      cache.clearAll()
      publish(true)
    },
  })

  const scroller: Scroller = createScroller({
    viewport,
    getCache: () => cache,
    getGeometry: geometry,
    applyCarry(next) {
      if (next === carry) return
      carry = next
      store.setState({ ...store.getState(), version: store.getState().version + 1, carry })
    },
    requestRange(startIndex, endIndex) {
      // Mount the destination so it is measured before a smooth scroll starts.
      const items = itemsFor([
        Math.max(0, startIndex - 1),
        Math.min(cache.length - 1, endIndex + 1),
      ])
      const previous = store.getState()
      const merged = [...previous.items]
      for (const item of items) {
        if (!merged.some((existing) => existing.key === item.key)) merged.push(item)
      }
      merged.sort((a, b) => a.index - b.index)
      store.setState({ ...previous, version: previous.version + 1, items: merged })
    },
    onScrollingChange() {
      publish(false)
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  return {
    store,
    cache,

    setOptions(next) {
      options = { ...options, ...next }
      if (next.visibility) tracker.setOptions(next.visibility)
      if (next.gap !== undefined) cache.setGap(next.gap)
      if (next.layoutSignature !== undefined) cache.setLayoutSignature(next.layoutSignature)

      const keysChanged = next.keys !== undefined && cache.setKeys(next.keys)
      // A key-set change moves every offset below the insertion point. Deriving
      // the offset from the anchor is the entirety of the prepend handling.
      publish(keysChanged)
    },

    mount() {
      const element = viewport.getElement()
      const cleanups: (() => void)[] = []

      if (element) {
        cleanups.push(resizer.observeViewport(element))
        gate = createScrollerGate({
          element,
          onChange: () => {
            publish(false)
          },
        })
        cleanups.push(() => {
          gate?.dispose()
          gate = null
        })
      }

      cleanups.push(
        viewport.addEventListener('scroll', () => {
          const offset = viewport.getScrollOffset()
          scroller.notifyScroll(offset)

          // The anchor records where the view *is*, so it follows every intentional
          // move — the user's and the scroller's alike. Skipping the scroller's
          // would leave the anchor pointing at the pre-scroll position, and the
          // next prepend or measurement would then dutifully teleport the view back
          // there. The one exception is our own anchor-restore write, whose
          // read-back may be snapped.
          if (!restoringScroll) anchor = deriveAnchor(offset, cache, geometry())
          publish(false)
        }),
      )

      const onPageHide = (): void => {
        // The only reliable unload hook: report anything visible but not yet
        // counted, so a reader who closes the tab is still credited.
        notifyVisibility(tracker.flushLeaves(now()))
      }
      const doc = element?.ownerDocument ?? globalThis.document
      const onDocumentVisibility = (): void => {
        if (doc.visibilityState === 'hidden') tracker.pauseDwell(now())
      }
      doc.addEventListener('visibilitychange', onDocumentVisibility)
      globalThis.addEventListener?.('pagehide', onPageHide)
      cleanups.push(() => {
        doc.removeEventListener('visibilitychange', onDocumentVisibility)
        globalThis.removeEventListener?.('pagehide', onPageHide)
      })

      anchor = deriveAnchor(viewport.getScrollOffset(), cache, geometry())
      publish(false)

      return () => {
        for (const cleanup of cleanups) cleanup()
      }
    },

    observeItem(element, key) {
      const measured = resizer.measure(element)
      const index = cache.indexOf(key)
      if (index >= 0 && measured > 0 && cache.setSize(index, measured)) {
        // Measure synchronously on mount. ResizeObserver's first callback lands
        // after the next rendering update, so waiting for it would paint one
        // frame at the wrong offset.
        publish(true)
        scroller.notifyMeasured()
      }
      return resizer.observeItem(element, key)
    },

    scrollToKey(key, scrollOptions) {
      const index = cache.indexOf(key)
      if (index < 0) {
        return Promise.resolve({ settled: false, deviation: 0, iterations: 0, reason: 'empty' as const })
      }
      return scroller.scrollToIndex(index, scrollOptions)
    },

    scrollToIndex(index, scrollOptions) {
      return scroller.scrollToIndex(index, scrollOptions)
    },

    getAnchor: () => anchor,

    setAnchor(next) {
      anchor = next
      publish(true)
    },

    takeSizeSnapshot: () => cache.snapshot(),

    getVisibility: (key) => tracker.get(key),

    subscribeVisibility(key, listener) {
      let listeners = visibilityListeners.get(key)
      if (!listeners) {
        listeners = new Set()
        visibilityListeners.set(key, listeners)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) visibilityListeners.delete(key)
      }
    },

    dispose() {
      disposed = true
      scroller.dispose()
      resizer.dispose()
      gate?.dispose()
      gate = null
      tracker.reset()
      visibilityListeners.clear()
    },
  }
}

/** Re-exported for the React adapter's convenience. */
export type { VirtualItem, VirtualState }

/**
 * Build the layout signature a size snapshot is keyed against.
 *
 * A height measured at a different container width, root font size or device
 * pixel ratio is not stale, it is *wrong* — restoring it would place the list
 * confidently in the wrong position. Including these in the key means a
 * responsive change or a browser zoom discards the snapshot instead.
 */
export function layoutSignatureFor(element: HTMLElement | null): string {
  if (!element) return ''
  const view = element.ownerDocument.defaultView
  const width = Math.round(element.clientWidth)
  const rootFontSize = view
    ? view.getComputedStyle(element.ownerDocument.documentElement).fontSize
    : ''
  const dpr = view?.devicePixelRatio ?? 1
  return `w=${String(width)}|f=${rootFontSize}|dpr=${String(dpr)}`
}
