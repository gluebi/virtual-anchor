import {
  createElementViewport,
  createEngine,
  createWindowViewport,
  type Anchor,
  type AnchorGeometry,
  type Engine,
  type ItemKey,
  type ScrollResult,
  type ScrollToOptions,
  type SizeSnapshot,
  type VirtualItem,
  type VirtualState,
  type VisibilityEvent,
  type VisibilityOptions,
  type Viewport,
  layoutSignatureFor,
  needsRerender,
  snapToDevicePixels,
} from 'virtual-anchor'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

export interface UseVirtualListOptions<T> {
  /** The loaded window, in display order. */
  items: readonly T[]
  /** Stable identity per item. Index-derived keys break every guarantee here. */
  getItemKey: (item: T, index: number) => ItemKey
  estimateSize?: (item: T, index: number) => number
  /** Fallback estimate before anything is measured. */
  defaultEstimate?: number
  /** Uniform spacing between items. Item margins are unsupported — see README. */
  gap?: number
  /** Extra px mounted beyond the viewport in each direction. Default 400. */
  buffer?: number
  /** Height of sticky chrome overlapping the top of the scrollport. */
  scrollPaddingStart?: number
  /** Height of chrome overlapping the bottom. */
  scrollPaddingEnd?: number
  /** Content above the list inside the scroller, for a window scroller. */
  scrollMargin?: number
  /** Keys always kept mounted, beyond the rendered range. */
  keepMounted?: readonly ItemKey[]
  visibility?: VisibilityOptions
  onVisibilityChange?: (events: VisibilityEvent[]) => void
  /** Restore measured sizes from a previous visit. */
  sizeSnapshot?: SizeSnapshot
  /** Scroll the page rather than an element. */
  windowScroller?: boolean
}

export interface RenderedItem<T> extends VirtualItem {
  readonly item: T
}

export interface UseVirtualListResult<T> {
  /** Attach to the scroll container. Omit when `windowScroller` is set. */
  scrollRef: (element: HTMLElement | null) => void
  /** Attach to the element that holds the items. */
  containerRef: (element: HTMLElement | null) => void
  /** Attach to each item. Handles measurement and positioning. */
  itemRef: (key: ItemKey) => (element: HTMLElement | null) => void
  items: ReadonlyArray<RenderedItem<T>>
  totalSize: number
  renderedRange: readonly [number, number]
  visibleRange: readonly [number, number]
  scrolling: boolean
  scrollToKey: (key: ItemKey, options?: ScrollToOptions) => Promise<ScrollResult>
  scrollToIndex: (index: number, options?: ScrollToOptions) => Promise<ScrollResult>
  getAnchor: () => Anchor | null
  setAnchor: (anchor: Anchor) => void
  takeSizeSnapshot: () => SizeSnapshot
  /** Total item count, for `aria-setsize` when the window is a slice. */
  count: number
  engine: Engine | null
}

const NO_RESULT: ScrollResult = { settled: false, deviation: 0, iterations: 0, reason: 'empty' as const }

/**
 * Headless virtual list.
 *
 * React decides *which* items are mounted; the library writes *where* they are,
 * straight to the DOM in a layout effect. React re-renders only when the mounted
 * key set changes, so most scroll frames involve no React work at all.
 *
 * That is not merely an optimisation. A scroll correction written inside a
 * ResizeObserver callback, paired with an asynchronously rendered set of new
 * positions, lets the browser paint one frame with the new scroll offset and the
 * old positions — a visible jump of exactly the correction, then a snap back
 * (TanStack #1227). Writing positions directly makes the same-paint guarantee
 * free instead of requiring `flushSync`.
 */
export function useVirtualList<T>(options: UseVirtualListOptions<T>): UseVirtualListResult<T> {
  const {
    items,
    getItemKey,
    estimateSize,
    defaultEstimate,
    gap,
    buffer,
    scrollPaddingStart,
    scrollPaddingEnd,
    scrollMargin,
    keepMounted,
    visibility,
    onVisibilityChange,
    sizeSnapshot,
    windowScroller = false,
  } = options

  const [engine, setEngine] = useState<Engine | null>(null)
  const scrollElement = useRef<HTMLElement | null>(null)
  const containerElement = useRef<HTMLElement | null>(null)
  const itemElements = useRef(new Map<ItemKey, HTMLElement>())
  /** Last written top per element, so unchanged positions are not re-written. */
  const writtenTops = useRef(new WeakMap<HTMLElement, number>())

  // Keys are derived once per items reference, so the cache's identity check
  // short-circuits on every render where the data did not change.
  const keys = useMemo(
    () => items.map((item, index) => getItemKey(item, index)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items],
  )

  const itemByKey = useMemo(() => {
    const map = new Map<ItemKey, T>()
    keys.forEach((key, index) => {
      const item = items[index]
      if (item !== undefined) map.set(key, item)
    })
    return map
  }, [items, keys])

  const geometry = useMemo<AnchorGeometry>(
    () => ({
      ...(scrollPaddingStart === undefined ? {} : { scrollPaddingStart }),
      ...(scrollPaddingEnd === undefined ? {} : { scrollPaddingEnd }),
      ...(scrollMargin === undefined ? {} : { scrollMargin }),
    }),
    [scrollPaddingStart, scrollPaddingEnd, scrollMargin],
  )

  // Callbacks are read through a ref so that changing them mid-flight does not
  // tear the engine down and lose the scroll position with it.
  const callbacks = useRef({ estimateSize, onVisibilityChange, getItemKey })
  callbacks.current = { estimateSize, onVisibilityChange, getItemKey }

  const scrollRef = useCallback(
    (element: HTMLElement | null) => {
      scrollElement.current = element
      if (windowScroller) return
      setEngine((previous) => {
        previous?.dispose()
        if (!element) return null
        return createEngine({
          viewport: createElementViewport(element),
          keys: [],
          layoutSignature: layoutSignatureFor(element),
        })
      })
    },
    [windowScroller],
  )

  // The window scroller has no element to attach to, so its engine is created on
  // mount instead of by a ref callback.
  useEffect(() => {
    if (!windowScroller) return
    const viewport: Viewport = createWindowViewport(window)
    const created = createEngine({
      viewport,
      keys: [],
      layoutSignature: layoutSignatureFor(document.documentElement),
    })
    setEngine(created)
    return () => {
      created.dispose()
      setEngine(null)
    }
  }, [windowScroller])

  /**
   * Write the content height straight to the DOM, synchronously.
   *
   * Handed to the engine so it can grow the container *before* writing a scroll
   * offset. Going through React state instead would put the height change in a
   * later commit, and the scroll write would be clamped against the old height —
   * which is a several-hundred-pixel jump on prepend, with nothing logged.
   */
  const setContentSize = useCallback((size: number) => {
    const container = containerElement.current
    if (container) container.style.height = `${String(size)}px`
  }, [])

  const containerRef = useCallback(
    (element: HTMLElement | null) => {
      containerElement.current = element
      if (element && engine) setContentSize(engine.store.getState().totalSize)
    },
    [engine, setContentSize],
  )

  // Push option changes into the engine during render rather than in an effect,
  // so a prepend is reflected in the very first commit that renders it — one
  // frame of stale positions is exactly the visible jump this design avoids.
  if (engine) {
    engine.setOptions({
      keys,
      geometry,
      ...(estimateSize === undefined
        ? {}
        : {
            estimateSize: (index: number, key: ItemKey) => {
              const item = itemByKey.get(key)
              return item === undefined ? (defaultEstimate ?? 120) : estimateSize(item, index)
            },
          }),
      ...(defaultEstimate === undefined ? {} : { defaultEstimate }),
      ...(gap === undefined ? {} : { gap }),
      ...(buffer === undefined ? {} : { buffer }),
      ...(keepMounted === undefined ? {} : { keepMounted }),
      ...(visibility === undefined ? {} : { visibility }),
      ...(sizeSnapshot === undefined ? {} : { sizeSnapshot }),
      onVisibilityChange: (events) => callbacks.current.onVisibilityChange?.(events),
      setContentSize,
    })
  }

  useEffect(() => engine?.mount(), [engine])

  // A versioned immutable snapshot, filtered so React only wakes for changes it
  // has to render. Reading the DOM inside a selector would be the canonical
  // tearing bug here: React may call it several times per render, so two rows
  // could observe different scroll positions in one pass.
  const state = useSyncExternalStore(
    useCallback(
      (onChange: () => void) => {
        if (!engine) return () => {}
        let previous = engine.store.getState()
        return engine.store.subscribe((next) => {
          if (!needsRerender(previous, next)) {
            previous = next
            return
          }
          previous = next
          onChange()
        })
      },
      [engine],
    ),
    useCallback(() => engine?.store.getState() ?? EMPTY, [engine]),
    useCallback(() => engine?.store.getState() ?? EMPTY, [engine]),
  )

  /**
   * Write positions to the DOM after every commit.
   *
   * `position: absolute; top: <px>` rather than `transform: translateY()`: a
   * fractional translate disables subpixel text antialiasing in Blink
   * (crbug 573146), which for a text-only forum is disqualifying. `top` does not
   * layerize and keeps the glyphs sharp.
   */
  useLayoutEffect(() => {
    const container = containerElement.current
    if (!container || !engine) return

    const current = engine.store.getState()
    const dpr = window.devicePixelRatio || 1

    // The height is written by the engine, before it writes any scroll offset —
    // see `setContentSize`. Re-asserting it here covers the first commit, where
    // the container mounts after the engine has already published.
    container.style.height = `${String(current.totalSize)}px`
    // The sub-pixel remainder the platform refused to take, applied once to the
    // whole container rather than chased with another scroll write.
    container.style.transform =
      current.carry === 0 ? '' : `translateY(${String(-current.carry)}px)`

    for (const item of current.items) {
      const element = itemElements.current.get(item.key)
      if (!element) continue
      const top = snapToDevicePixels(item.start, dpr)
      if (writtenTops.current.get(element) === top) continue
      writtenTops.current.set(element, top)
      element.style.position = 'absolute'
      element.style.left = '0'
      element.style.right = '0'
      element.style.top = `${String(top)}px`
    }
  })

  const itemRef = useCallback(
    (key: ItemKey) => (element: HTMLElement | null) => {
      if (!element || !engine) return undefined
      itemElements.current.set(key, element)
      const stopObserving = engine.observeItem(element, key)
      // React 19 ref cleanup: pairs observe with unobserve exactly, with no
      // null-ref dance and no second code path.
      return () => {
        itemElements.current.delete(key)
        stopObserving()
      }
    },
    [engine],
  )

  const rendered = useMemo<ReadonlyArray<RenderedItem<T>>>(() => {
    const result: Array<RenderedItem<T>> = []
    for (const item of state.items) {
      const data = itemByKey.get(item.key)
      if (data === undefined) continue
      result.push({ ...item, item: data })
    }
    return result
  }, [state.items, itemByKey])

  const scrollToKey = useCallback(
    (key: ItemKey, scrollOptions?: ScrollToOptions) =>
      engine?.scrollToKey(key, scrollOptions) ?? Promise.resolve(NO_RESULT),
    [engine],
  )

  const scrollToIndex = useCallback(
    (index: number, scrollOptions?: ScrollToOptions) =>
      engine?.scrollToIndex(index, scrollOptions) ?? Promise.resolve(NO_RESULT),
    [engine],
  )

  return {
    scrollRef,
    containerRef,
    itemRef,
    items: rendered,
    totalSize: state.totalSize,
    renderedRange: state.renderedRange,
    visibleRange: state.visibleRange,
    scrolling: state.scrolling,
    scrollToKey,
    scrollToIndex,
    getAnchor: useCallback(() => engine?.getAnchor() ?? null, [engine]),
    setAnchor: useCallback(
      (anchor: Anchor) => {
        engine?.setAnchor(anchor)
      },
      [engine],
    ),
    takeSizeSnapshot: useCallback(
      () =>
        engine?.takeSizeSnapshot() ?? {
          version: 1 as const,
          layoutSignature: '',
          estimate: 0,
          sizes: [],
        },
      [engine],
    ),
    count: items.length,
    engine,
  }
}

const EMPTY: VirtualState = {
  version: 0,
  items: [],
  renderedRange: [0, -1],
  visibleRange: [0, -1],
  totalSize: 0,
  carry: 0,
  scrollOffset: 0,
  viewportSize: 0,
  scrolling: false,
}
