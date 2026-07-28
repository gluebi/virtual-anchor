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
  EMPTY_STATE,
  layoutSignatureFor,
  needsRerender,
} from 'virtual-anchor'
import {
  useCallback,
  useEffect,
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

const noopRef = (): undefined => undefined

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

  const containerElement = useRef<HTMLElement | null>(null)

  /**
   * The one thing that writes to the DOM.
   *
   * Declared before the engine because the engine takes it, and identity-stable
   * because `containerRef` used to depend on `engine` — so React detached the container
   * before attaching the item refs on the first commit, and the content-size write
   * no-oped against a null container while the scroll write proceeded against a stale
   * height. The closure reads the ref when the engine calls it, after commit, not
   * during render.
   */
  const surface = useMemo(
    () => createDomSurface({ container: containerElement }),
    [],
  )

  /**
   * The scroll element is state, so the engine can be *derived* rather than assigned.
   *
   * The engine used to be built inside a `setState` updater, which React may invoke
   * more than once — StrictMode does so by design — so two engines were constructed,
   * only the second was kept, and the first leaked its scroller's DOM listeners for
   * good. The window-scroller path had the same bug in another shape: `setEngine`
   * called synchronously inside an effect, a cascading render that
   * `react-hooks/set-state-in-effect` rightly rejects.
   *
   * A ref callback is not render, so setting state from one is fine.
   */
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
  const scrollRef = useCallback((element: HTMLElement | null) => {
    setScrollElement(element)
  }, [])

  const engine = useMemo(() => {
    if (windowScroller) {
      // The window is available immediately, so this needs no element and no ref.
      return createEngine({
        viewport: createWindowViewport(window),
        keys: [],
        surface,
        layoutSignature: layoutSignatureFor(document.documentElement),
      })
    }
    if (!scrollElement) return null
    return createEngine({
      viewport: createElementViewport(scrollElement),
      keys: [],
      surface,
      layoutSignature: layoutSignatureFor(scrollElement),
    })
  }, [windowScroller, scrollElement, surface])

  // Dispose whatever a previous derivation produced. Constructing an engine attaches
  // no listeners — `mount()` does that — so building one during render is inert.
  useEffect(
    () => () => {
      engine?.dispose()
    },
    [engine],
  )

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
      onVisibilityChange: (events) => onVisibilityChange?.(events),
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
   * Stable per-key ref callbacks, from the engine.
   *
   * The cache lives with the element registry rather than in React: held here it was
   * either a ref read during render or a mutated memo, and a mutable render-stable
   * cache is not React's to hold.
   */
  const itemRef = useCallback(
    (key: ItemKey) => engine?.itemRef(key) ?? noopRef,
    [engine],
  )

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

