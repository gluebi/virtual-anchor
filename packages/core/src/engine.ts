import {
  carryFor,
  deriveAnchor,
  isSelfWrite,
  resolveAnchorOffset,
} from './anchor.js'
import { ListGeometry, type ListInsets } from './listGeometry.js'
import { createScrollerGate, type ScrollerGate } from './gate.js'
import { createResizer, type Resizer } from './resizer.js'
import { createScroller, type Scroller } from './scroller.js'
import { createNullSurface, type Surface } from './surface.js'
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
   * Everything the engine draws.
   *
   * One owner, so that content size, scroll offset and item positions are written in
   * a single ordered pass. The ordering is not incidental: a prepend makes the
   * restored offset exceed the old maximum, and a write past it is silently clamped.
   * Defaults to a surface that draws nothing, which is what a headless test wants.
   */
  surface?: Surface
  now?: () => number
}

export interface Engine {
  readonly store: VirtualStore
  readonly cache: SizeCache
  setOptions(options: Partial<EngineOptions>): void
  /** Attach the scrollport. Returns its own teardown. */
  mount(): () => void
  observeItem(element: Element, key: ItemKey): () => void
  /**
   * A stable ref callback for an item.
   *
   * Memoised per key *here*, because the identity has to survive every render and the
   * cache belongs with the element registry rather than in React. Held in the adapter
   * it was either a ref read during render or a mutated memo — both of which the
   * React-compiler lint rules reject, and rightly: a mutable render-stable cache is
   * not React's to hold.
   */
  itemRef(key: ItemKey): (element: HTMLElement | null) => (() => void) | undefined
  scrollToKey(key: ItemKey, options?: ScrollToOptions): Promise<ScrollResult>
  scrollToIndex(index: number, options?: ScrollToOptions): Promise<ScrollResult>
  getAnchor(): Anchor | null
  setAnchor(anchor: Anchor): void
  takeSizeSnapshot(): SizeSnapshot
  /** Abandon any in-flight programmatic scroll, resolving it as unsettled. */
  cancelScroll(): void
  /**
   * Move focus to an item, if it is mounted.
   *
   * On the engine because it already owns the element registry; the alternative was a
   * second key→element map in the component plus a `dataset` round-trip to recover a
   * key React knew at render time.
   */
  focusItem(key: ItemKey): boolean
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

  const surface: Surface = options.surface ?? createNullSurface()
  const store = createVirtualStore()
  const tracker = new VisibilityTracker(options.visibility ?? {})
  const visibilityListeners = new Map<ItemKey, Set<() => void>>()
  /**
   * One ref callback per key, so React never sees a changed ref identity.
   *
   * Pruned to the rendered window on every publish, so it cannot outgrow the list.
   */
  const itemRefCallbacks = new Map<ItemKey, (element: HTMLElement | null) => (() => void) | undefined>()

  /** The position of record. Everything else is derived from it. */
  let anchor: Anchor | null = null
  /**
   * Offsets this module has written from the anchor, awaiting their scroll events.
   *
   * A queue rather than a boolean for the same reason the scroller keeps one: scroll
   * events are delivered *asynchronously*, so a flag set and cleared around a
   * synchronous write is always back to `false` by the time the event arrives. The
   * guard it replaced therefore never once fired.
   *
   * What it guards matters. The anchor must follow the *scroller's* writes — those
   * move the view intentionally, and not following them leaves the anchor describing
   * the pre-scroll position so the next prepend teleports the view back there. But it
   * must *not* follow an anchor-restore, because that read-back may have been snapped
   * to a whole pixel: absorbing that into `offsetWithinItem` re-introduces the very
   * residual the carry just removed, which shows up as a landing exactly 0.5px off.
   */
  const restoreIntents: number[] = []
  const MAX_RESTORE_INTENTS = 5
  /** Whether a scrollport observation has established a layout signature yet. */
  let signatureKnown = options.layoutSignature !== undefined
  /** Teardown for whatever `mount()` attached, so `dispose()` can undo all of it. */
  let unmount: (() => void) | null = null
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

  /** Last applied carry, so an unchanged value is not re-written to the DOM. */
  let carry = 0
  const applyCarry = (next: number): void => {
    if (next === carry) return
    carry = next
    surface.setCarry(next)
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
    surface.setContentSize(totalSize)

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
        restoreIntents.push(restored)
        if (restoreIntents.length > MAX_RESTORE_INTENTS) restoreIntents.shift()
        viewport.setScrollOffset(restored)

        // Recover the fraction the platform refused to take — the same treatment
        // every scroller write gets. This path had been writing raw, which meant the
        // *most frequent* correction (a measurement landing, a prepend) was the one
        // place the carry did not apply. It went unnoticed only because a first-frame
        // `clearAll()` used to force a fresh scroller write straight afterwards; with
        // that gone, a cold-start deep link lands exactly 0.5px short without this.
        applyCarry(carryFor(restored, viewport.getScrollOffset()))
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
      scrollOffset,
      viewportSize: viewport.getViewportSize(),
      scrolling: scroller.isScrolling(),
    })

    // Positions are written here rather than by the consumer after commit, so the
    // content size, the scroll offset and the item positions all land in one pass.
    // Items not yet attached are positioned by `observeItem` the moment their element
    // exists, which is before paint.
    for (const item of items) surface.setItemOffset(item.key, item.start)

    // Keep the ref-callback cache bounded by what is rendered rather than by
    // everything ever scrolled past.
    if (itemRefCallbacks.size > items.length * 4) {
      const live = new Set(items.map((item) => item.key))
      for (const key of itemRefCallbacks.keys()) {
        if (!live.has(key)) itemRefCallbacks.delete(key)
      }
    }

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
  })

  /**
   * A scrollport resize.
   *
   * Reached from `viewport.observeSize`, which is the only thing that knows what to
   * watch for the scroller kind in play.
   */
  /**
   * A scrollport resize.
   *
   * Driven by `viewport.observeSize`, which is the only thing that knows what to watch
   * for the scroller kind in play.
   */
  function onViewportResize(): void {
    // Only a change that reflows text invalidates measurements — and the *height* of the
    // scrollport reflows nothing. A mobile URL bar hiding, devtools opening, a soft
    // keyboard appearing or a vertical window drag all resize the scrollport without
    // changing a single line box, so discarding the cache for them is pure waste;
    // combined with a restored snapshot it is destructive.
    //
    // `layoutSignatureFor` already hashes exactly the things that *do* reflow — content
    // width, root font size, device pixel ratio — and is already the key a size snapshot
    // is trusted against. Reusing it means one definition of "the layout changed".
    const signature = layoutSignatureFor(viewport.getElement())
    const changed = cache.setLayoutSignature(signature)

    // The first observation merely learns the signature; there is no previous layout for
    // it to differ from, and clearing would throw away measurements taken moments
    // earlier during mount.
    if (changed && signatureKnown) cache.clearAll()
    signatureKnown = true

    publish(true)
  }

  const scroller: Scroller = createScroller({
    viewport,
    getCache: () => cache,
    getGeometry: geometry,
    applyCarry,
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
      // Idempotent: a second mount would add a second scroll listener and overwrite
      // `gate`, orphaning the first behind a teardown closure nobody holds.
      if (unmount) return unmount

      // The scroller binds its input listeners here rather than at construction, so
      // that building an engine has no side effects and a speculatively-constructed one
      // cannot leak them.
      scroller.attach()

      const cleanups: (() => void)[] = []

      // The viewport owns knowing what to watch. The engine used to observe
      // `getElement()`, and for a document scroller that is `documentElement`, whose
      // border-box height is the *content* height — so every content growth read as a
      // viewport resize and discarded the whole measurement cache.
      cleanups.push(
        viewport.observeSize(() => {
          onViewportResize()
        }),
      )

      const gateTarget = viewport.getGateTarget()
      if (gateTarget) {
        gate = createScrollerGate({
          element: gateTarget,
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
          // move — the user's and the scroller's alike. The one exception is our own
          // anchor-restore write, whose read-back may have been snapped to a whole
          // pixel; re-deriving from that would fold the platform's rounding into the
          // anchor and undo the carry.
          const restoreIndex = restoreIntents.findIndex((value) => isSelfWrite(offset, value))
          if (restoreIndex === -1) {
            anchor = deriveAnchor(offset, cache, geometry())
          } else {
            restoreIntents.splice(0, restoreIndex + 1)
          }
          publish(false)
        }),
      )

      const onPageHide = (): void => {
        // The only reliable unload hook: report anything visible but not yet
        // counted, so a reader who closes the tab is still credited.
        notifyVisibility(tracker.flushLeaves(now()))
      }
      const doc = viewport.getElement()?.ownerDocument ?? globalThis.document
      const onDocumentVisibility = (): void => {
        if (doc.visibilityState === 'hidden') tracker.pauseDwell(now())
      }
      doc.addEventListener('visibilitychange', onDocumentVisibility)
      globalThis.addEventListener('pagehide', onPageHide)
      cleanups.push(() => {
        doc.removeEventListener('visibilitychange', onDocumentVisibility)
        globalThis.removeEventListener('pagehide', onPageHide)
      })

      anchor = deriveAnchor(viewport.getScrollOffset(), cache, geometry())
      publish(false)

      const teardown = (): void => {
        for (const cleanup of cleanups) cleanup()
        cleanups.length = 0
        if (unmount === teardown) unmount = null
      }
      unmount = teardown
      return teardown
    },

    observeItem(element, key) {
      const detachFromSurface = surface.attachItem(key, element as HTMLElement)
      const index = cache.indexOf(key)

      // Position it before anything can paint. A newly mounted item has no offset
      // written yet, and `publish` cannot have positioned it because its element did
      // not exist at the time.
      if (index >= 0) surface.setItemOffset(key, cache.offsetOf(index))

      const measured = resizer.measure(element)
      if (index >= 0 && measured > 0 && cache.setSize(index, measured)) {
        // Measure synchronously on mount. ResizeObserver's first callback lands
        // after the next rendering update, so waiting for it would paint one
        // frame at the wrong offset.
        publish(true)
        scroller.notifyMeasured()
      }

      const stopObserving = resizer.observeItem(element, key)
      return () => {
        stopObserving()
        detachFromSurface()
      }
    },

    scrollToKey(key, scrollOptions) {
      const index = cache.indexOf(key)
      if (index < 0) {
        // Distinct from 'empty': the list has items, this key is not among them —
        // almost always a caller that changed the loaded window and scrolled before the
        // change reached the list, which is a completely different fix.
        return Promise.resolve({
          settled: false,
          deviation: 0,
          iterations: 0,
          reason: 'unknown-key' as const,
        })
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

    cancelScroll: () => {
      scroller.cancel()
    },

    itemRef(key) {
      const existing = itemRefCallbacks.get(key)
      if (existing) return existing

      const callback = (element: HTMLElement | null): (() => void) | undefined => {
        if (element === null || disposed) return undefined
        return this.observeItem(element, key)
      }
      itemRefCallbacks.set(key, callback)
      return callback
    },

    focusItem: (key) => surface.focusItem(key),

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
      // Undo `mount()` too. Leaving its scroll, visibilitychange and pagehide listeners
      // attached kept the cache, store and tracker reachable — a whole engine retained
      // per disposed list for anyone using the core directly. The React adapter only
      // avoided it by accident of effect-cleanup ordering.
      unmount?.()
      itemRefCallbacks.clear()
      surface.dispose()
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
