import {
  createElementViewport,
  createDomSurface,
  createEngine,
  createWindowViewport,
  documentScrollElement,
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
  EMPTY_STATE,
  layoutSignatureFor,
  needsRerender,
} from '../index.js'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

/**
 * Store-driven renders per second that mean something is looping.
 *
 * Ten times what a continuously scrolling list needs, which is one per frame.
 */
const RENDER_STORM_PER_SECOND = 600

/** A one-second window of store-driven renders. */
interface Burst {
  at: number
  count: number
  warned: boolean
}

/**
 * Complain once per second if the store is driving renders faster than any real scroll can.
 *
 * Guarded by its single caller so a production build drops it, which is the convention the
 * `trace` module documents.
 */
function warnOnRenderStorm(burst: Burst): void {
  const now = Date.now()
  if (now - burst.at > 1000) {
    burst.at = now
    burst.count = 0
    burst.warned = false
  }

  burst.count++
  if (burst.count <= RENDER_STORM_PER_SECOND || burst.warned) return

  burst.warned = true
  console.error(
    `[virtual-anchor] over ${String(RENDER_STORM_PER_SECOND)} store-driven renders in a ` +
      'second. A publish is provoking a render that publishes again — this is a loop, and ' +
      'without this message it would spin silently.',
  )
}

/**
 * A permanently stable reporter that hands a value to the consumer's latest callback, later.
 *
 * Every notification this adapter forwards comes out of an engine publish, and a publish is not
 * always post-commit: options are pushed into the engine *during* render, deliberately, so a
 * prepend is positioned in the very commit that renders it. Called straight from there, a
 * consumer's `setState` is a cross-component update from a render phase — React's "Cannot update a
 * component while rendering a different component", reported against the library, with the stack
 * trace pointing at the consumer's own callback. The same hop for the same reason as the re-render
 * subscription below, which has always had one.
 *
 * The value is captured rather than re-read on arrival, which is what keeps the notification
 * describing the publish that caused it: a burst inside one tick is delivered as the sequence that
 * occurred, not as the last state repeated. Whether to notify at all stays at the emission too —
 * the de-duplication refs and the engine's edge latch are both written synchronously — so only who
 * is told, and when, moves.
 *
 * Nothing cancels a scheduled hand-off, and that is deliberate. StrictMode runs an effect's
 * cleanup *before* the queued microtask, while the reported-value refs deliberately outlive the
 * effect — so a `disposed` guard would drop the opening report, and the remount pass, finding it
 * already reported, would queue nothing to replace it. Consumers would learn where the list
 * started in production and not in development. What not guarding costs is one late call when a
 * publish and an unmount land in the same tick, which React absorbs.
 *
 * The identity never changes, which two of the four callers need for their own reasons: one is
 * installed as an engine option, where a fresh identity per render would reinstall it every time,
 * and two are read from inside a subscription keyed on the engine alone. The box is written during
 * render rather than from an effect, deliberately — React flushes passive effects *after*
 * microtasks, so a box written there would give back the previous commit's callback in exactly the
 * publish-during-render case this exists for. `react-hooks/refs` is off for this directory for the
 * same family of reasons; see `eslint.config.js`.
 */
function useHandOff<A>(listener: ((value: A) => void) | undefined): (value: A) => void {
  const latest = useRef(listener)
  latest.current = listener
  return useCallback((value: A) => {
    queueMicrotask(() => latest.current?.(value))
  }, [])
}

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
  /**
   * Extra px mounted beyond the viewport, widened in the direction of travel.
   *
   * Carries no number on purpose: the default is measured rather than chosen, and this doc is
   * what typedoc publishes — a literal here is a copy that goes stale the next time it is
   * re-measured. `DEFAULT_BUFFER` in `engine.ts` states it, and says what it was measured
   * against.
   */
  buffer?: number
  /** Height of sticky chrome overlapping the top of the scrollport. */
  scrollPaddingStart?: number
  /** Height of chrome overlapping the bottom. */
  scrollPaddingEnd?: number
  /** Content above the list inside the scroller, for a window scroller. */
  scrollMargin?: number
  /**
   * Stay pinned to the end of the list as it grows. Off by default.
   *
   * For a chat, a log tail, a thread with a live reply arriving. Held with an
   * instant write rather than an animation: the destination moves on every
   * append and on every measurement of a message still streaming in, and an
   * animation chasing that is the hazard the README's fetching contract
   * describes. The pin survives a prepend and a late measurement for free, since
   * both go through the same publish.
   *
   * Dropped the moment the reader scrolls away deliberately, and restored when
   * they scroll back to the bottom. "Deliberately" means a wheel, a touch, a
   * pointer or a key — never an offset the browser moved on its own.
   */
  followOutput?: boolean
  /** How close to the end still counts as being at it, in px. Default 4. */
  atBottomThreshold?: number
  /** Hold short content against the bottom of the scroller rather than the top. */
  alignToBottom?: boolean
  /**
   * Fires when the view arrives at, or leaves, the end of the list.
   *
   * A notification for the same reason `onVisibleRangeChange` is one: it is fed
   * from a store subscription rather than a render, so it costs no renders and
   * cannot be stale. Delivered after the publish that caused it, never during a
   * render — see {@link onVisibleRangeChange}.
   */
  onAtBottomChange?: (atBottom: boolean) => void
  /**
   * Fires when either end of the loaded window comes within
   * {@link edgeReachedThreshold} px — where you load the next page.
   *
   * Suppressed while a programmatic scroll is in flight, which is the reason to
   * use this rather than an `onScroll` handler: fetching mid-animation moves the
   * target the animation is chasing, and the newly inserted items are unmeasured
   * so it keeps moving. The library cannot decide *whether* to fetch, but it can
   * refuse to ask at the one moment the answer must be no.
   *
   * Whether an edge has been reached is decided at the publish, so that
   * suppression still reads the scroll state as it was; *you* are told a
   * microtask later, so setting state from here is safe — see
   * {@link onVisibleRangeChange}.
   */
  onEdgeReached?: (edge: 'start' | 'end') => void
  /** How near an edge counts as reaching it, in px. Default 600. */
  edgeReachedThreshold?: number
  /** Keys always kept mounted, beyond the rendered range. */
  keepMounted?: readonly ItemKey[]
  visibility?: VisibilityOptions
  /**
   * Fires with each batch of visibility transitions.
   *
   * Delivered after the sample that produced it, never during a render — see
   * {@link onVisibleRangeChange}. Each event's `at` is stamped at the sample, so a batch
   * describes when it was taken rather than when it arrived.
   */
  onVisibilityChange?: (events: VisibilityEvent[]) => void
  /**
   * Fires when the on-screen index range changes. Buffer excluded, unlike Virtuoso's
   * `rangeChanged`.
   *
   * A notification rather than a value, because the range is not something a render can observe:
   * `needsRerender` deliberately omits it, so a scroll that moves the visible range within the
   * mounted set produces no React work at all — which is the point of this library, and also the
   * reason a `visibleRange` field would be stale exactly while the user is scrolling.
   *
   * Fed by a store subscription, so it costs no renders of its own. What a consumer does with it
   * — set state, fetch a page, update a progress indicator — is theirs to decide.
   *
   * **Delivered a microtask after the publish that caused it, never during a render.** Options are
   * pushed into the engine during render, so the publish behind a range change routinely happens
   * mid-render; called synchronously from there, a consumer's `setState` would hit React's "Cannot
   * update a component while rendering a different component". The hop costs nothing observable —
   * a microtask still runs before paint — and it means the range you are handed is the one that
   * caused the notification, not whatever the store holds by the time you read it.
   */
  onVisibleRangeChange?: (range: readonly [number, number]) => void
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
  /**
   * Attach to content sharing the scroller with the list. Handles measurement.
   *
   * One ref per slot rather than one parameterised by slot, because unlike
   * `itemRef` the set is closed: there are four of these and there will be four
   * of them tomorrow, so naming them costs nothing and reads as markup rather
   * than as a lookup.
   *
   * **Order matters.** Render them as `VirtualList` does — header, stickyHeader,
   * the item container, footer, stickyFooter — because that is the layout the
   * measured heights are composed for. A `stickyHeader` placed below the items
   * would be counted as space above them, and every offset would be wrong by its
   * height. Nothing can check this for you: the library never sees your markup,
   * only the boxes it is handed.
   */
  headerRef: (element: HTMLElement | null) => void
  stickyHeaderRef: (element: HTMLElement | null) => void
  footerRef: (element: HTMLElement | null) => void
  stickyFooterRef: (element: HTMLElement | null) => void
  items: readonly RenderedItem<T>[]
  totalSize: number
  renderedRange: readonly [number, number]
  /**
   * The index range genuinely on screen, buffer excluded, read live.
   *
   * A getter rather than a field, and that is the whole point: `renderedRange` above is a field
   * because it *is* part of `needsRerender`, so a render always sees a current one. The visible
   * range is not, so a field fed from the render snapshot would sit still through exactly the
   * scrolling it is meant to describe. Read this when you need the value now — a keyboard
   * handler, a fetch decision — and use `onVisibleRangeChange` when you need to react to it.
   */
  getVisibleRange: () => readonly [number, number]
  scrolling: boolean
  scrollToKey: (key: ItemKey, options?: ScrollToOptions) => Promise<ScrollResult>
  scrollToIndex: (index: number, options?: ScrollToOptions) => Promise<ScrollResult>
  /** Abandon any in-flight programmatic scroll, resolving it as unsettled. */
  cancelScroll: () => void
  getAnchor: () => Anchor | null
  setAnchor: (anchor: Anchor) => void
  takeSizeSnapshot: () => SizeSnapshot
  /** Total item count, for `aria-setsize` when the window is a slice. */
  count: number
  /**
   * The key at a collection index, mounted or not.
   *
   * Keyboard navigation is defined over the collection, not over what happens to be
   * rendered, so it needs to name an item the DOM does not currently contain. Surfaced
   * here rather than reached for through `engine`, because the README presents the
   * headless hook as a first-class path and the library's own keyboard behaviour has to
   * be expressible on it.
   */
  keyAt: (index: number) => ItemKey | undefined
  /** Move focus to an item, if it is mounted. Returns whether it could. */
  focusItem: (key: ItemKey) => boolean
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
    onVisibleRangeChange,
    followOutput,
    atBottomThreshold,
    alignToBottom,
    onAtBottomChange,
    onEdgeReached,
    edgeReachedThreshold,
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
    // The window is available immediately, so that mode needs no element and no ref; an
    // element scroller has to wait for one. Beyond the viewport and the element the
    // signature is taken from, the two are the same engine.
    //
    // The scrollport, not `documentElement`, and it has to match what the engine recomputes the
    // signature from on its first scrollport observation — read a different element there and
    // that observation sees a change and clears every measurement, snapshot included.
    const measured = windowScroller ? documentScrollElement(window) : scrollElement
    if (!measured) return null

    return createEngine({
      viewport: windowScroller ? createWindowViewport(window) : createElementViewport(measured),
      keys: [],
      surface,
      layoutSignature: layoutSignatureFor(measured),
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

  /**
   * The consumer's `estimateSize` and the key→item map, read through boxes.
   *
   * Assigned during render because the wrapper below is called during render too — pushing
   * options into the engine rebuilds the offset tree, which asks for estimates immediately.
   */
  const latestEstimateSize = useRef(estimateSize)
  latestEstimateSize.current = estimateSize
  const latestItemByKey = useRef(itemByKey)
  latestItemByKey.current = itemByKey

  /**
   * The estimator handed to the engine: (item, index) translated to its (index, key).
   *
   * Permanently stable, and every input read through a box, because the cache compares this by
   * reference to decide whether to rebuild its offset tree. Depending on anything that changes
   * per render meant rebuilding every slot, republishing, and re-aiming any in-flight scroll —
   * which is not merely slow: it makes a smooth `scrollToKey` chase a target that keeps moving,
   * and the accuracy matrix failed by a pixel.
   *
   * A call site naturally writes `estimateSize={(comment) => …}`, a fresh closure each render,
   * so that identity was never usable. `itemByKey` is no better: it changes exactly when `keys`
   * does, and `setEstimateSize` runs *before* `setKeys` — so a data change rebuilt once against
   * the outgoing key set and then again against the incoming one, the first pass wasted
   * entirely. Whether the estimator is installed at all is decided at the call below, by
   * omitting the option, which is what leaves the median estimator enabled for a list that
   * supplies no estimate of its own.
   *
   * Returns `undefined` for a key it cannot resolve, rather than reproducing the cache's own
   * fallback here — the cache already prefers `defaultEstimate` and then its learned median.
   */
  const estimateForIndex = useCallback((index: number, key: ItemKey): number | undefined => {
    const item = latestItemByKey.current.get(key)
    return item === undefined ? undefined : latestEstimateSize.current?.(item, index)
  }, [])

  /**
   * The four notifications this adapter forwards, every one of them handed over later.
   *
   * Declared together because the property that matters is that they agree: each is called from
   * an engine publish, a publish can land mid-render, and a consumer's `setState` from any of
   * them would be React's cross-component update. One of these was guarded and its neighbour was
   * not, which is how the bug arrived.
   *
   * `onEdgeReached` is the sharpest, because its documented use *is* a state change — "where you
   * load the next page" begins with a `setState` — and it needs no interaction to reach: a list
   * opening at the top is already at its start edge, and the publish that notices sits in the
   * very render that hands the engine its options.
   *
   * `onVisibilityChange` is the one with no reproduction behind it. It sits on the same stack,
   * but a rule with a `dwellMs` reports `enter` from a timer rather than from the sample, and
   * every attempt to force one produced events only after the commit. Deferred for uniformity;
   * each event carries an `at` stamped at the sample, so a batch still describes when it was
   * taken rather than when it lands.
   */
  const reportRange = useHandOff(onVisibleRangeChange)
  const reportAtBottom = useHandOff(onAtBottomChange)
  const reportEdgeReached = useHandOff(onEdgeReached)
  const reportVisibility = useHandOff(onVisibilityChange)

  // Push option changes into the engine during render rather than in an effect,
  // so a prepend is reflected in the very first commit that renders it — one
  // frame of stale positions is exactly the visible jump this design avoids.
  if (engine) {
    engine.setOptions({
      keys,
      geometry,
      ...(estimateSize === undefined ? {} : { estimateSize: estimateForIndex }),
      ...(defaultEstimate === undefined ? {} : { defaultEstimate }),
      ...(gap === undefined ? {} : { gap }),
      ...(buffer === undefined ? {} : { buffer }),
      ...(keepMounted === undefined ? {} : { keepMounted }),
      ...(visibility === undefined ? {} : { visibility }),
      ...(sizeSnapshot === undefined ? {} : { sizeSnapshot }),
      ...(followOutput === undefined ? {} : { followOutput }),
      ...(atBottomThreshold === undefined ? {} : { atBottomThreshold }),
      ...(alignToBottom === undefined ? {} : { alignToBottom }),
      ...(edgeReachedThreshold === undefined ? {} : { edgeReachedThreshold }),
      // Spread conditionally rather than always wrapped, unlike the visibility
      // callback: the engine skips the whole edge computation when no listener is
      // installed, and a wrapper would defeat that for every list that has none.
      // The wrapper it gets when there *is* one is permanently stable, so a call
      // site's inline arrow does not reinstall an option every render.
      ...(onEdgeReached === undefined ? {} : { onEdgeReached: reportEdgeReached }),
      // Always installed, unlike the edge callback: the engine samples visibility regardless of
      // whether anyone is listening, and this is only where a batch is handed on.
      onVisibilityChange: reportVisibility,
    })
  }

  /**
   * The last range handed to `onVisibleRangeChange`.
   *
   * Outside the effect, not seeded from the store inside it, and that distinction is the whole
   * behaviour: options are pushed into the engine *during render*, so a range has usually been
   * published before any effect runs. Seeding from the store would adopt that first range
   * silently and the consumer would never learn where the list started. Starting from the empty
   * sentinel reports it.
   */
  const reportedRange = useRef<readonly [number, number]>(EMPTY_STATE.visibleRange)

  /**
   * The same, for `atBottom`.
   *
   * Seeded to `null` rather than to `EMPTY_STATE.atBottom`, which is `true`: an
   * empty list *is* at its bottom, so seeding from it would swallow the first
   * report for every list that starts there — including a chat opened with
   * `followOutput`, whose whole first fact is that it is pinned.
   */
  const reportedAtBottom = useRef<boolean | null>(null)

  /**
   * Report visible-range and at-bottom changes straight from the store.
   *
   * One subscription for both, not one each: the store notifies on every publish —
   * every scroll frame — so a second listener is a second callback per frame for
   * two fields out of one snapshot. Neither is in `needsRerender`, which is what
   * makes both free of React work.
   *
   * Declared *before* the mount effect below, so any publish `mount()` provokes is observed too.
   *
   * For the range a reference check is enough: the engine hands back the *same* tuple while it
   * is unchanged, so identity means "this range moved" rather than "something published".
   *
   * Keyed on the engine alone, with the callbacks read through boxes: a call site passing an
   * inline arrow would otherwise unsubscribe and resubscribe on every render, re-reading the
   * store and allocating closures each time. The cost of that is small, but this file goes
   * out of its way to avoid exactly this shape elsewhere.
   *
   * **What is reported is decided here; who is told is a microtask later**, through
   * {@link useHandOff} — the same split the re-render subscription below makes, and for the
   * same reason. The de-duplication is what has to stay on this side of it: compared at the
   * emission, in publish order, against a ref nothing else can have moved.
   */
  useEffect(() => {
    if (!engine) return

    const notify = (state: VirtualState): void => {
      if (state.visibleRange !== reportedRange.current) {
        reportedRange.current = state.visibleRange
        reportRange(state.visibleRange)
      }
      if (state.atBottom !== reportedAtBottom.current) {
        reportedAtBottom.current = state.atBottom
        reportAtBottom(state.atBottom)
      }
    }

    notify(engine.store.getState())
    return engine.store.subscribe(notify)
    // The reporters never change identity, so this is still keyed on the engine alone.
  }, [engine, reportRange, reportAtBottom])

  useEffect(() => engine?.mount(), [engine])

  /**
   * A development-only detector for the failure the microtask hop below would otherwise
   * hide: a publish that provokes a render that publishes again.
   *
   * React's own "Maximum update depth exceeded" only fires for updates nested inside a
   * render or effect. Once the notification hops a microtask, each cycle is a separate
   * task, so React sees unrelated root updates and says nothing.
   *
   * Counted in the notify path and reported inline, *not* from a timer: React schedules
   * sync-lane root work on the microtask queue too, so the whole cycle — publish, notify,
   * render, publish — stays on that queue and never yields to a timer. An interval would
   * have been silent in precisely the case it was written for, which was measured rather
   * than assumed. A `console.error` is one of the few things that escapes a microtask spin.
   */
  const burst = useRef<Burst>({ at: 0, count: 0, warned: false })

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
          // A microtask, not a direct call: options are pushed into the engine *during
          // render* so a prepend is positioned in the same commit, and the publish that
          // follows would otherwise call this synchronously mid-render — React's
          // "Cannot update a component while rendering a different component", which
          // every consumer would see in development.
          //
          // Nothing is delayed that anyone can observe. React re-reads the snapshot for
          // the render already in progress, item positions are written straight to the
          // DOM rather than through React, and a microtask still runs before paint.
          //
          // The one thing it costs is React's own "Maximum update depth exceeded", which
          // catches a render→publish→render cycle loudly. A cycle here would instead spin
          // on microtasks in silence, so development keeps a detector of its own.
          if (process.env.NODE_ENV !== 'production') warnOnRenderStorm(burst.current)
          queueMicrotask(onChange)
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

  /**
   * The four slot refs, resolved once per engine.
   *
   * `engine.slotRef` memoises per slot, so these identities are stable for the
   * life of the engine — which is the whole requirement: a ref whose identity
   * changed per render would detach and reattach the observer every time, and
   * a slot detaching is not free, it zeroes the measured height and republishes.
   */
  const slotRefs = useMemo(
    () => ({
      headerRef: engine?.slotRef('header') ?? noopRef,
      stickyHeaderRef: engine?.slotRef('stickyHeader') ?? noopRef,
      footerRef: engine?.slotRef('footer') ?? noopRef,
      stickyFooterRef: engine?.slotRef('stickyFooter') ?? noopRef,
    }),
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
    ...slotRefs,
    items: rendered,
    totalSize: state.totalSize,
    renderedRange: state.renderedRange,
    // Straight from the store rather than from `state`, so a caller reading it mid-scroll gets
    // where the view actually is and not where the last render left it.
    getVisibleRange: useCallback(
      () => engine?.store.getState().visibleRange ?? EMPTY_STATE.visibleRange,
      [engine],
    ),
    keyAt: useCallback((index: number) => engine?.keyAt(index), [engine]),
    // Through the engine, which already owns the element registry. The component used to
    // keep a second `Map<ItemKey, HTMLElement>` — which leaked every element ever mounted,
    // because its cleanup branch is unreachable under React 19's ref semantics — and
    // recovered the key from a `data-` attribute React knew at render time.
    focusItem: useCallback((key: ItemKey) => engine?.focusItem(key) ?? false, [engine]),
    scrolling: state.scrolling,
    scrollToKey,
    scrollToIndex,
    cancelScroll: useCallback(() => {
      engine?.cancelScroll()
    }, [engine]),
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

