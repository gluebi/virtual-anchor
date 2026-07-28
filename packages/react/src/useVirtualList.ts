import {
  createElementViewport,
  createDomSurface,
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
  type VisibilityEvent,
  type VisibilityOptions,
  type Viewport,
  EMPTY_STATE,
  layoutSignatureFor,
  needsRerender,
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
  items: readonly RenderedItem<T>[]
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
          surface,
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
      surface,
      layoutSignature: layoutSignatureFor(document.documentElement),
    })
    setEngine(created)
    return () => {
      created.dispose()
      setEngine(null)
    }
  }, [windowScroller])

  /**
   * The one thing that writes to the DOM.
   *
   * Created once and identity-stable, which matters: `containerRef` previously
   * depended on `engine`, so React detached it before attaching the item refs on the
   * first commit — and the content-size write then no-oped against a null container
   * while the scroll write proceeded against a stale height.
   */
  const surface = useMemo(
    () => createDomSurface({ getContainer: () => containerElement.current }),
    [],
  )

  const containerRef = useCallback((element: HTMLElement | null) => {
    containerElement.current = element
  }, [])

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
    useCallback(() => engine?.store.getState() ?? EMPTY_STATE, [engine]),
    useCallback(() => engine?.store.getState() ?? EMPTY_STATE, [engine]),
  )

  /**
   * One ref callback per key, memoised.
   *
   * `itemRef(key)` previously built a fresh closure on every call, and the component
   * wrapped it in an inline arrow besides — so every mounted item's ref identity
   * changed on every render and React dutifully ran the cleanup and re-attached. That
   * cost a forced `getBoundingClientRect` and an unobserve/observe pair per item per
   * render, and the cleanup's `lastSizes.delete` defeated the resizer's value-dedupe,
   * so a full synthetic ResizeObserver batch was manufactured the following frame.
   * During first-pass scrolling that is every frame — precisely when the claim of "no
   * React work on most scroll frames" is supposed to hold.
   */
  const itemRefs = useRef(new Map<ItemKey, (element: HTMLElement | null) => void>())

  const itemRef = useCallback(
    (key: ItemKey) => {
      const existing = itemRefs.current.get(key)
      if (existing) return existing

      const callback = (element: HTMLElement | null): (() => void) | undefined => {
        if (!element || !engine) return undefined
        const detach = engine.observeItem(element, key)
        // React 19 ref cleanup. Returning it means React never calls this back with
        // `null`, which is what made the component's own `else …delete()` branch
        // unreachable and leaked every element ever mounted.
        return detach
      }
      itemRefs.current.set(key, callback)
      return callback
    },
    [engine],
  )

  // Keep the callback cache bounded by the rendered window rather than by everything
  // ever scrolled past.
  useEffect(() => {
    const live = new Set(state.items.map((item) => item.key))
    for (const key of itemRefs.current.keys()) {
      if (!live.has(key)) itemRefs.current.delete(key)
    }
  }, [state.items])

  const rendered = useMemo<readonly RenderedItem<T>[]>(() => {
    const result: RenderedItem<T>[] = []
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

