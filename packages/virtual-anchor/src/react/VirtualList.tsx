import type {
  Anchor,
  Engine,
  ItemKey,
  ScrollResult,
  ScrollToOptions,
  SizeSnapshot,
} from '../index.js'
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  type UIEvent as ReactUIEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useVirtualList, type RenderedItem, type UseVirtualListOptions } from './useVirtualList.js'

export interface VirtualListHandle {
  /**
   * Whether a programmatic scroll is in flight.
   *
   * Check this in `onScroll` before fetching a page. A `scrollToKey` crossing an edge
   * would otherwise trigger a load, the load would move every offset below it, and the
   * target would keep moving faster than the animation could converge on it — so a
   * smooth scroll during active pagination never settles. The library cannot decide this
   * for you, because when to fetch is a product question; what it can do is tell you
   * when not to.
   */
  isScrolling: () => boolean
  scrollToKey: (key: ItemKey, options?: ScrollToOptions) => Promise<ScrollResult>
  scrollToIndex: (index: number, options?: ScrollToOptions) => Promise<ScrollResult>
  getAnchor: () => Anchor | null
  setAnchor: (anchor: Anchor) => void
  takeSizeSnapshot: () => SizeSnapshot
}

export interface VirtualListProps<T> extends UseVirtualListOptions<T> {
  renderItem: (item: T, rendered: RenderedItem<T>) => ReactNode
  /**
   * Total number of items in the whole collection, not just the loaded window.
   *
   * Reported as `aria-setsize`, so a screen reader says "comment 4211 of 12000"
   * rather than describing the overscan window as the entire thread. Defaults to
   * the loaded count, which is only correct when everything is loaded.
   */
  totalCount?: number
  /**
   * 1-based position of the first *loaded* item within the whole collection.
   *
   * Without this, `aria-posinset` would report the index within the loaded window
   * — announcing "comment 1 of 12000" for what is really comment 4192, which is
   * worse than saying nothing. Defaults to 1, which is correct only when the
   * window starts at the beginning of the collection.
   */
  firstItemPosition?: number
  /**
   * Content rendered inside the scroller, above the list.
   *
   * This is what `scrollMargin` describes — a list sharing a scroller with content
   * above it. Without a slot for that content the option was reachable only from the
   * headless hook, so the component could describe a layout it could not produce.
   *
   * Its height must equal `scrollMargin`: the library treats it as static, because
   * measuring it would mean the list's own origin moved and every offset with it.
   */
  before?: ReactNode

  /** Whether a page is currently loading, for `aria-busy`. */
  loading?: boolean
  /** Accessible name for the feed. */
  label?: string
  className?: string
  style?: CSSProperties
  itemClassName?: string
  /** Move focus to the target once a `scrollToKey` settles. Default true. */
  focusOnScrollEnd?: boolean
  /**
   * Raw scroll events from the scrollport.
   *
   * Exposed so a consumer can trigger bidirectional pagination near either edge.
   * The library does not do that itself: when to fetch, and how much, is a
   * product decision, and the anchor already guarantees the resulting prepend
   * cannot move the view.
   */
  onScroll?: (event: ReactUIEvent<HTMLDivElement>) => void
  /**
   * Ref to the scrollport element.
   *
   * The handle is the scroll *API*; this is the *node*. A consumer sharing the scroller with
   * another behaviour — pull-to-refresh, a scroll-linked gradient, a third-party scroll library
   * — needs the element itself, and the alternatives are a `firstElementChild` off a wrapper or
   * a marker class, both of which encode this component's DOM shape at the call site.
   *
   * Reach for the handle to *move* the scroller and this to *observe* it. Writing `scrollTop`
   * through this ref means fighting the convergence loop, which is the one thing it is not for.
   *
   * With `windowScroller` there is no scrollport of ours — the page scrolls — so this resolves
   * to `document.scrollingElement`. That is `documentElement` in standards mode, which is what
   * the engine measures; in quirks mode the two can differ.
   */
  scrollerRef?: Ref<HTMLElement>
  /**
   * The engine, once one exists — and `null` when it is torn down.
   *
   * `useItemVisibility(engine, key)` is presented as a first-class API, but no `VirtualList`
   * consumer could reach an `Engine` to call it with. A callback rather than a field on the
   * handle because that hook *subscribes* through the engine, so it has to be reactive: in
   * element-scroller mode the engine does not exist until the scrollport ref has attached, and
   * a handle read during render would return `null` forever.
   *
   * Called with `null` on teardown, so a consumer holding it in state cannot keep subscribing
   * to a disposed engine.
   */
  onEngineReady?: (engine: Engine | null) => void
  ref?: Ref<VirtualListHandle>
}

/** Nothing to undo — a ref that was never published to. */
const NO_RELEASE = (): void => {}

/**
 * Publish a value to a consumer's ref, whichever of the two shapes it is, and return the undo.
 *
 * Written here because there is no merged-ref helper in this package and no dependency that
 * provides one. React 19 lets a callback ref return its own cleanup, so that has to be honoured
 * rather than discarded — a consumer whose ref tears something down would otherwise leak it.
 */
function applyRef<T>(ref: Ref<T> | undefined, value: T | null): () => void {
  if (!ref) return NO_RELEASE

  if (typeof ref === 'function') {
    const cleanup = ref(value)
    return typeof cleanup === 'function' ? cleanup : () => ref(null)
  }

  ref.current = value
  return () => {
    ref.current = null
  }
}

/**
 * The page scroller, for `windowScroller` mode.
 *
 * `scrollingElement` rather than `documentElement` because that is the element the platform
 * actually scrolls, and narrowed by `instanceof` rather than asserted: the property is typed
 * `Element | null`, and it really is null on a detached document.
 */
function pageScroller(): HTMLElement {
  const scrolling = document.scrollingElement
  return scrolling instanceof HTMLElement ? scrolling : document.documentElement
}

/**
 * When the *page* scrolls, this element must not scroll as well.
 *
 * The component used to apply the scrollport styles unconditionally while passing
 * `windowScroller` through to the hook, so the DOM shape and the viewport choice were
 * decided independently with nothing reconciling them — a nested scroller inside a
 * window-scrolled list.
 */
const WINDOW_HOST_STYLE: CSSProperties = {
  position: 'relative',
}

/**
 * The scrollport.
 *
 * Deliberately minimal: sizing is the consumer's business, and anything opinion-
 * ated here fights their layout. `contain: size` and `flex: none` in particular
 * must NOT go on this element — they belong on the inner container, which has an
 * explicit height. Putting them here collapses the scroller to zero height inside
 * a flex parent, and since inline styles beat a stylesheet the consumer cannot
 * override it.
 */
const SCROLLER_STYLE: CSSProperties = {
  position: 'relative',
  overflowY: 'auto',
  // Also on the container, which is what covers the window-scrolled mode. Both, because
  // this is the element the browser selects an anchor *within* when there is one, and the
  // `before` slot's subtree is inside it.
  overflowAnchor: 'none',
  // A stray `scroll-behavior: smooth` inherited from the page would animate every
  // corrective write and fight the convergence loop.
  scrollBehavior: 'auto',
}

/**
 * The sizer, and the positioning context for the items.
 *
 * A *sibling* of nothing and an ancestor of the items — but its height is written
 * by us rather than derived from them, which is what keeps the total-height write
 * from invalidating the observed items and manufacturing
 * "ResizeObserver loop completed with undelivered notifications".
 */
const CONTAINER_STYLE: CSSProperties = {
  position: 'relative',
  width: '100%',
  contain: 'size style',
  // The browser's own scroll anchoring would correct at the same time we do, and the two
  // fight. Blazor's Virtualize disables it for the same reason, noting it can otherwise
  // reach an infinite rendering loop.
  //
  // Here as well as on the scrollport, because a window-scrolled list has no scrollport of
  // ours — which left native anchoring live in exactly the mode where the document is the
  // thing being anchored. This element holds the list rows in both modes.
  overflowAnchor: 'none',
}

const ITEM_STYLE: CSSProperties = {
  // `flow-root` establishes a block formatting context so a consumer's margins
  // cannot escape and silently corrupt offsets, and `contain` stops an item's
  // internals from invalidating list-level layout.
  display: 'flow-root',
  contain: 'layout style',
  boxSizing: 'border-box',
}

/**
 * A virtual list with the ARIA feed pattern, focus retention and pixel-perfect
 * `scrollToKey`.
 *
 * `role="feed"` rather than `role="list"`: the feed pattern exists for exactly
 * this case — a scrollable collection of articles loaded incrementally, where not
 * all of it is in the DOM. A list cannot express "you are at comment 4211 of
 * 12000" while only sixty are mounted, and omitting `aria-setsize` makes the
 * overscan window sound like the whole thread.
 */
export function VirtualList<T>(props: VirtualListProps<T>): ReactNode {
  const {
    renderItem,
    totalCount,
    firstItemPosition = 1,
    before,
    loading = false,
    label,
    className,
    style,
    itemClassName,
    focusOnScrollEnd = true,
    onScroll,
    scrollerRef,
    onEngineReady,
    ref,
    ...listOptions
  } = props

  /**
   * The focused key is pinned into the mounted set.
   *
   * When a focused row scrolls out of the rendered window and unmounts, focus
   * falls back to `<body>` and a keyboard user loses their place entirely. This
   * is the single worst virtualization bug for keyboard navigation.
   */
  const [focusedKey, setFocusedKey] = useState<ItemKey | null>(null)
  // Merged, not replaced. Replacing meant a single click into the feed silently
  // unmounted every key the consumer had pinned.
  const keepMounted = useMemo(
    () =>
      focusedKey === null
        ? listOptions.keepMounted
        : [...(listOptions.keepMounted ?? []), focusedKey],
    [listOptions.keepMounted, focusedKey],
  )

  const list = useVirtualList({
    ...listOptions,
    ...(keepMounted === undefined ? {} : { keepMounted }),
  })

  /**
   * Scroll to an item and give it focus once the motion has genuinely stopped.
   *
   * Waiting for the settle promise is what keeps focus from landing mid-flight, and
   * moving it at all is what makes a permalink usable with a screen reader. Shared by
   * the imperative handle and the keyboard contract so the two cannot drift — they had,
   * with only one of them honouring `focusOnScrollEnd`.
   */
  const scrollAndFocus = useCallback(
    async (key: ItemKey, options: ScrollToOptions, moveFocus: boolean) => {
      const result = await list.scrollToKey(key, options)
      if (moveFocus) list.focusItem(key)
      return result
    },
    [list],
  )

  const windowScroller = listOptions.windowScroller === true

  /**
   * The consumer's ref, in a box, assigned during render.
   *
   * Read from here rather than closed over, so nothing below has to depend on an identity that
   * changes: the ref that feeds `list.scrollRef` sets the state the engine is derived from, so a
   * changed identity would have React detach and reattach it — `null`, then the element —
   * disposing and rebuilding the engine. An inline `scrollerRef` at the call site is therefore
   * harmless, which is what a call site will naturally write.
   */
  const consumerScrollerRef = useRef(scrollerRef)
  consumerScrollerRef.current = scrollerRef
  /** Undo for whatever the consumer's ref did with the node. */
  const releaseScroller = useRef(NO_RELEASE)

  // Destructured, so the dependency is the callback rather than the result object: `list` is
  // fresh every render, and depending on it would defeat the whole point of this indirection.
  const { scrollRef } = list
  const setScrollport = useCallback(
    (element: HTMLElement | null) => {
      scrollRef(element)

      if (element === null) {
        releaseScroller.current()
        releaseScroller.current = NO_RELEASE
        return
      }
      // In the commit's ref phase, not an effect: a consumer whose `useEffect(…, [])` reads
      // `scrollerRef.current` once must not find it empty.
      releaseScroller.current = applyRef(consumerScrollerRef.current, element)
    },
    // Permanently stable: `scrollRef` is a `useCallback` with no dependencies, and the consumer's
    // ref is reached through a box rather than a dependency.
    [scrollRef],
  )

  /**
   * Cover the window-scrolled mode, which has no element of ours to attach to.
   *
   * Keyed on the mode alone: depending on the consumer's ref would re-run this on every render
   * for an inline arrow, publishing `null` and then the element again each time. `pageScroller()`
   * always resolves, so there is nothing to guard against.
   */
  useEffect(() => {
    if (!windowScroller) return
    return applyRef(consumerScrollerRef.current, pageScroller())
  }, [windowScroller])

  /**
   * Hand the engine out, and take it back when it goes.
   *
   * The callback is read through a box for the same reason as the ref above: keyed on its
   * identity, an inline arrow would tear this down and re-run it every render — handing the
   * consumer `null` and then the engine again. Since the documented use is to hold it in state,
   * that is a state update per render, whose render brings a fresh arrow, which re-runs the
   * effect. Pass a stable callback if you need a *swap* to be noticed; the engine itself
   * changing is what this reports.
   */
  const latestEngineListener = useRef(onEngineReady)
  latestEngineListener.current = onEngineReady

  useEffect(() => {
    const notify = latestEngineListener.current
    if (!notify) return
    notify(list.engine)
    return () => {
      notify(null)
    }
  }, [list.engine])

  useImperativeHandle(
    ref,
    () => ({
      scrollToKey: (key, options) => scrollAndFocus(key, options ?? {}, focusOnScrollEnd),
      isScrolling: () => list.scrolling,
      scrollToIndex: list.scrollToIndex,
      getAnchor: list.getAnchor,
      setAnchor: list.setAnchor,
      takeSizeSnapshot: list.takeSizeSnapshot,
    }),
    [list, focusOnScrollEnd, scrollAndFocus],
  )

  /**
   * Move focus to an item by its position in the collection.
   *
   * Focus follows the scroll rather than being left behind: <kbd>Ctrl</kbd>+<kbd>End</kbd>
   * used to move the view to the last comment and abandon the keyboard user's focus
   * where it was, so the next <kbd>PageDown</kbd> continued from the old place and the
   * abandoned row stayed pinned and mounted.
   *
   * Addressed by collection index, so an unmounted neighbour is reachable — stepping
   * through the mounted array made the behaviour depend on what happened to be
   * rendered.
   */
  const moveFocusTo = useCallback(
    (index: number, align: 'start' | 'end') => {
      const key = list.keyAt(index)
      if (key === undefined) return false
      // Always moves focus, whatever `focusOnScrollEnd` says: that option is about
      // whether *navigating* claims focus, and a keyboard user pressing PageDown has
      // already claimed it. Moving the view without it is what left them behind.
      void scrollAndFocus(key, { align }, true)
      return true
    },
    [list, scrollAndFocus],
  )

  /**
   * The feed pattern's keyboard contract: page keys move between articles.
   *
   * All four keys are the same action — move focus to a collection index — so they differ
   * only in which index and which alignment. `moveFocusTo` returning false when the index
   * is outside the collection is what handles both ends, so no branch needs its own bound
   * check.
   */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const focused =
        focusedKey === null ? undefined : list.items.find((item) => item.key === focusedKey)
      // With nothing focused, paging starts from what the reader is looking at — read live,
      // because a scroll within the mounted set publishes no render, so the snapshot's range can
      // be a whole buffer out of date by the time a key arrives.
      const from = focused?.index ?? list.getVisibleRange()[0]

      const target = ((): readonly [number, 'start' | 'end'] | undefined => {
        if (event.ctrlKey) {
          if (event.key === 'Home') return [0, 'start']
          if (event.key === 'End') return [list.count - 1, 'end']
          return undefined
        }
        if (event.key === 'PageDown') return [from + 1, 'start']
        if (event.key === 'PageUp') return [from - 1, 'start']
        return undefined
      })()

      if (!target) return
      const [index, align] = target
      if (moveFocusTo(index, align)) event.preventDefault()
    },
    [list, focusedKey, moveFocusTo],
  )

  const setSize = totalCount ?? list.count

  return (
    <div
      // A window-scrolled list has no scrollport of its own to attach to.
      ref={windowScroller ? undefined : setScrollport}
      className={className}
      style={{ ...(windowScroller ? WINDOW_HOST_STYLE : SCROLLER_STYLE), ...style }}
      onScroll={onScroll}
      onFocus={(event) => {
        // `closest`, not the target's own dataset: only the row carries the key, so
        // focus landing on a link or button inside a row would otherwise fail to pin
        // it — leaving the worst keyboard bug unfixed for any row with content.
        const row = (event.target as HTMLElement).closest<HTMLElement>('[data-virtual-key]')
        if (row?.dataset.virtualKey !== undefined) setFocusedKey(row.dataset.virtualKey)
      }}
      onBlur={(event) => {
        // Release the pin only when focus leaves the feed entirely, not when it
        // moves between rows.
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusedKey(null)
        }
      }}
    >
      {before}
      {/* `role="feed"` sits here rather than on the scrollport because this is the
          element whose children are the articles — and with a `before` slot the
          scrollport now has a non-article child. */}
      <div
        ref={list.containerRef}
        style={CONTAINER_STYLE}
        role="feed"
        aria-busy={loading}
        aria-label={label}
        // On the feed rather than the scrollport: with a `before` slot the scrollport also
        // contains whatever the consumer put there, and a filter input or a nested
        // scrollable region inside it would have its page keys swallowed. Events from the
        // articles still bubble to here.
        onKeyDown={onKeyDown}
      >
        {list.items.map((rendered) => (
          <div
            key={rendered.key}
            // The memoised per-key callback, passed straight through. An inline arrow
            // here would change identity every render and undo the memoisation — and
            // discarding its return value would discard React 19's ref cleanup.
            ref={list.itemRef(rendered.key)}
            data-virtual-key={rendered.key}
            className={itemClassName}
            style={ITEM_STYLE}
            role="article"
            tabIndex={0}
            aria-posinset={firstItemPosition + rendered.index}
            aria-setsize={setSize}
          >
            {renderItem(rendered.item, rendered)}
          </div>
        ))}
      </div>
    </div>
  )
}
