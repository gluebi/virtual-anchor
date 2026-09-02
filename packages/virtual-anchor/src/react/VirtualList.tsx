import {
  documentScrollElement,
  type Anchor,
  type Engine,
  type ItemKey,
  type ScrollResult,
  type ScrollToOptions,
  type SizeSnapshot,
  type SlotName,
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
  /**
   * Abandon any in-flight programmatic scroll, resolving it as unsettled.
   *
   * On the engine since it existed, but reachable from neither the hook nor the
   * component — so every consumer that did not build its own engine could start
   * a smooth scroll and had no way to stop it.
   */
  cancelScroll: () => void
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
   * Content inside the scroller, above the list, that scrolls away with it.
   *
   * A thread description, a filter summary, a cover image. Measured, so there is
   * no height to declare and nothing to keep in sync — which is the difference
   * between this and the `before` slot it replaces, whose height had to equal
   * `scrollMargin` exactly or every landing was out by the difference, silently
   * and forever.
   *
   * Measuring it is only safe because the anchor names an item rather than an
   * offset: when the header grows — a font swaps, an image decodes, a
   * translation arrives — the derived `scrollTop` grows by exactly as much and
   * the view does not move. Every other virtual list either declines to measure
   * (virtua's `startMargin`, TanStack's `scrollMargin`) or measures without
   * compensating, which is the jump behind react-virtuoso #1245.
   */
  header?: ReactNode
  /**
   * Content inside the scroller, above the list, pinned to the top edge.
   *
   * A filter bar, a "jump to unread" button. Rendered below `header`, so the
   * header scrolls out from under it.
   *
   * It occupies in-flow space *and* covers the top of the scrollport, so it
   * counts towards both where the list starts and how much room the items have
   * — which is why it is a different slot rather than a styling choice on
   * `header`. Declaring both separately is the distinction react-virtuoso needed
   * `headerHeight` and `fixedHeaderHeight` for, and the one TanStack had to add
   * `scrollPaddingStart` to recover.
   */
  stickyHeader?: ReactNode
  /**
   * Content inside the scroller, below the list, that scrolls away with it.
   *
   * An "end of thread" note, a loading spinner for older comments. Measured, and
   * excluded from `align: 'end'` — scrolling the last comment to the bottom of
   * the screen stops at the comment, not at whatever follows it.
   */
  footer?: ReactNode
  /**
   * Content inside the scroller, below the list, pinned to the bottom edge.
   *
   * A composer, a "N new comments" pill. Rendered after `footer`, so the footer
   * scrolls above it. Counts against the height available to items, so an item
   * aligned to the end comes to rest above it rather than behind it.
   *
   * The bottom edge, not the last comment — on a thread too short to fill the
   * scrollport the remaining room is held as empty space below the items, and the
   * slack opens between the last comment and this. `position: sticky` alone cannot
   * do that: it lifts a box to an edge and never pushes one down to one, which is
   * why an empty state or a filtered-to-nothing list leaves every other library's
   * composer floating halfway up the box. The space stops at the scrollport, so a
   * short thread gains no scroll range from it.
   */
  stickyFooter?: ReactNode

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
   * Reserve the scrollbar's width in the scrollport from the start. Default true.
   *
   * A scrollbar that appears once the rows overflow narrows the scrollport, and a width change
   * invalidates every height measured before it — so the list discards them, correctly. The rows
   * from before are outside the window by then and will never be re-measured: they keep their
   * estimate for good, and every offset computed from them is out by the difference. The symptom
   * is a scrollbar slightly the wrong length and a `scrollToKey` that overshoots on a cold list,
   * neither of which points back at the cause.
   *
   * The default is `true` because that reasoning is not application-specific: it holds for any
   * list that measures variable-height rows in a scroller it owns, which is what this component
   * is. A setting every correct call site must pass, for a reason the caller cannot see, is the
   * component's default rather than the caller's responsibility.
   *
   * **It does not hold on WebKit for a scroller with styled scrollbars.** A width on
   * `::-webkit-scrollbar` opts the scroller out of overlay scrollbars, and WebKit then reserves
   * nothing until the scrollbar actually exists — so the scrollport narrows on first overflow
   * exactly as it would without the property, and everything above happens anyway. Chromium and
   * Firefox both hold their width; `getComputedStyle` reads back `stable` on all three, so the
   * property cannot be tested for. Nothing here can fix it — the property is set and ignored — so
   * a consumer styling `::-webkit-scrollbar` has to reserve the width in that stylesheet, and a
   * development build warns once if the scrollport moves anyway (#116).
   *
   * **Ignored under `windowScroller`**, whatever it is set to. There the page is the scroller, and
   * reserving a gutter on the document is the host page's decision — not a list's.
   *
   * Set it to `false` when the scroller is styled by the host page in a way this fights.
   * `both-edges` is deliberately not offered: it is a layout preference, and `style` already
   * reaches this element — an explicit `style={{ scrollbarGutter: … }}` wins over this prop
   * either way.
   */
  stableScrollbarGutter?: boolean
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
   * to whatever the document actually scrolls: `documentElement` in standards mode, `body` in
   * quirks mode. The library resolves it in one place, so the node you get here is the same one
   * it clamps and fingerprints against.
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
 *
 * The one thing that did earn a place here is below, and it is the exception that
 * shows what the rule is about: a reserved scrollbar gutter is not a look, it is
 * what the list's own measurements are taken against.
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
 * The scrollport, with the scrollbar's width reserved — the default.
 *
 * The single exception to the rule above, and it earns one because the failure it prevents is
 * *internal*: the width every early measurement was taken at, not how the list looks. The
 * mechanism is on {@link VirtualListProps.stableScrollbarGutter}, where a consumer deciding
 * whether to opt out will look for it.
 *
 * Thin as impositions go — reserved only on a scrollport this component created, the width the
 * scrollbar was about to take anyway, and one prop to turn off.
 */
const SCROLLER_STYLE_STABLE_GUTTER: CSSProperties = {
  ...SCROLLER_STYLE,
  scrollbarGutter: 'stable',
}

/**
 * What this component styles its host element as, which depends on whether it is the scroller.
 *
 * The gutter question does not arise in window-scrolled mode: there is no scrollport of ours to
 * reserve it in, and the document's is the host page's business.
 */
function hostStyleFor(windowScroller: boolean, stableScrollbarGutter: boolean): CSSProperties {
  if (windowScroller) return WINDOW_HOST_STYLE
  return stableScrollbarGutter ? SCROLLER_STYLE_STABLE_GUTTER : SCROLLER_STYLE
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

/**
 * A measured slot wrapper.
 *
 * `flow-root` for the same reason an item gets it, and it matters more here: a
 * margin on the consumer's own content would escape the wrapper, and no
 * ResizeObserver box includes margins — so the height we measure would be short
 * by it and every item below would sit that much too high. Establishing a block
 * formatting context makes that unrepresentable rather than merely warned about.
 *
 * Deliberately no `contain: size`: unlike the item container, whose height we
 * write, a slot's height is whatever its content makes it. That is the whole
 * point of measuring it.
 *
 * Styling is left to the consumer through `[data-virtual-slot]` rather than a
 * className prop per slot. react-virtuoso wraps header content in a div nobody
 * can reach and had to add a `headerFooterTag` string prop to let people change
 * even the tag name; a data attribute costs no API and no bytes.
 */
const SLOT_STYLE: CSSProperties = {
  display: 'flow-root',
}

/**
 * A slot pinned to an edge of the scrollport.
 *
 * `z-index` because the items are absolutely positioned inside a container that
 * comes later in the DOM, so a sticky sibling without one paints underneath
 * them. The containing block is the scrollport's content box, which spans the
 * whole scroll length — so unlike react-virtuoso, where the viewport is
 * absolutely positioned and a sticky header only sticks for one viewport of
 * scrolling (#1237), these stick for the length of the list.
 */
const STICKY_HEADER_STYLE: CSSProperties = {
  ...SLOT_STYLE,
  position: 'sticky',
  top: 0,
  zIndex: 1,
}

const STICKY_FOOTER_STYLE: CSSProperties = {
  ...SLOT_STYLE,
  position: 'sticky',
  bottom: 0,
  zIndex: 1,
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
 * One measured slot, or nothing when the consumer supplied none.
 *
 * Written once rather than four times so that `data-virtual-slot` — which is the
 * entire documented styling API for these wrappers — is spelled in one place and
 * typed as {@link SlotName}, rather than hand-written four times with nothing
 * tying the strings to the type.
 *
 * Absent rather than empty when there is no content: four always-present
 * wrappers would be four boxes to reason about, and four ResizeObserver
 * registrations, for the overwhelmingly common list that has none.
 */
function Slot({
  name,
  node,
  slotRef,
  style,
}: {
  name: SlotName
  node: ReactNode
  slotRef: (element: HTMLElement | null) => void
  style: CSSProperties
}): ReactNode {
  if (node === undefined) return null
  return (
    <div ref={slotRef} data-virtual-slot={name} style={style}>
      {node}
    </div>
  )
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
    header,
    stickyHeader,
    footer,
    stickyFooter,
    loading = false,
    label,
    className,
    style,
    itemClassName,
    focusOnScrollEnd = true,
    stableScrollbarGutter = true,
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

  /**
   * Attach the scrollport, and publish it to the consumer's ref.
   *
   * One mechanism for both modes. The host `<div>` renders either way — it simply must not feed
   * `list.scrollRef` when the page is the scroller, since a window-scrolled list has no
   * scrollport of its own to derive an engine from. What the consumer is *handed* differs: the
   * div in element mode, the page scroller in window mode, resolved by the viewport module so
   * this component holds no opinion about quirks mode.
   *
   * In the commit's ref phase rather than an effect, and that is the reason this is the surviving
   * mechanism: a consumer whose `useEffect(…, [])` reads `scrollerRef.current` once must not find
   * it empty. Publishing window mode from an effect also re-ran it per render for an inline ref.
   */
  const setScrollport = useCallback(
    (element: HTMLElement | null) => {
      if (!windowScroller) scrollRef(element)

      releaseScroller.current()
      releaseScroller.current =
        element === null
          ? NO_RELEASE
          : applyRef(
              consumerScrollerRef.current,
              windowScroller ? documentScrollElement(window) : element,
            )
    },
    // `scrollRef` is a `useCallback` with no dependencies and the consumer's ref is reached
    // through a box, so the only thing that can change this identity is the mode — which already
    // rebuilds the engine when it flips.
    [scrollRef, windowScroller],
  )

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
      cancelScroll: list.cancelScroll,
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
      // One ref in both modes. It only feeds `list.scrollRef` when this element really is the
      // scrollport; see `setScrollport`.
      ref={setScrollport}
      className={className}
      // The consumer's `style` last, so an explicit `scrollbarGutter` — or anything else here —
      // is theirs to overrule.
      style={{ ...hostStyleFor(windowScroller, stableScrollbarGutter), ...style }}
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
      <Slot name="header" node={header} slotRef={list.headerRef} style={SLOT_STYLE} />
      <Slot
        name="stickyHeader"
        node={stickyHeader}
        slotRef={list.stickyHeaderRef}
        style={STICKY_HEADER_STYLE}
      />
      {/* `role="feed"` sits here rather than on the scrollport because this is the
          element whose children are the articles — and with the slots around it the
          scrollport now has non-article children. */}
      <div
        ref={list.containerRef}
        style={CONTAINER_STYLE}
        role="feed"
        aria-busy={loading}
        aria-label={label}
        // On the feed rather than the scrollport: the scrollport also contains whatever
        // the consumer put in the slots, and a filter input or a nested scrollable
        // region inside one would have its page keys swallowed. Events from the
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
      <Slot name="footer" node={footer} slotRef={list.footerRef} style={SLOT_STYLE} />
      <Slot
        name="stickyFooter"
        node={stickyFooter}
        slotRef={list.stickyFooterRef}
        style={STICKY_FOOTER_STYLE}
      />
    </div>
  )
}
