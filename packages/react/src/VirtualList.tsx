import type { Anchor, ItemKey, ScrollResult, ScrollToOptions, SizeSnapshot } from 'virtual-anchor'
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
  type UIEvent as ReactUIEvent,
  useCallback,
  useImperativeHandle,
  useMemo,
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
  ref?: Ref<VirtualListHandle>
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
  // The browser's own scroll anchoring would correct at the same time we do, and
  // the two fight. Blazor's Virtualize disables it for the same reason, noting it
  // can otherwise reach an infinite rendering loop.
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
    loading = false,
    label,
    className,
    style,
    itemClassName,
    focusOnScrollEnd = true,
    onScroll,
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

  // Focus goes through the engine, which already owns the element registry. The
  // component previously kept a second `Map<ItemKey, HTMLElement>` — which leaked
  // every element ever mounted, because its cleanup branch was unreachable under
  // React 19's ref semantics — and recovered the key from a `data-` attribute that
  // React knew at render time.
  const focusKey = useCallback(
    (key: ItemKey) => list.engine?.focusItem(key) ?? false,
    [list.engine],
  )

  useImperativeHandle(
    ref,
    () => ({
      scrollToKey: async (key, options) => {
        const result = await list.scrollToKey(key, options)
        // Deep-linking is a navigation, so the target takes focus once motion has
        // genuinely stopped — which is what makes a permalink usable with a
        // screen reader at all. Waiting for the settle promise means focus never
        // lands mid-flight.
        if (focusOnScrollEnd) focusKey(key)
        return result
      },
      isScrolling: () => list.scrolling,
      scrollToIndex: list.scrollToIndex,
      getAnchor: list.getAnchor,
      setAnchor: list.setAnchor,
      takeSizeSnapshot: list.takeSizeSnapshot,
    }),
    [list, focusOnScrollEnd, focusKey],
  )

  /** The feed pattern's keyboard contract: page keys move between articles. */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const { items } = list
      if (items.length === 0) return

      const currentIndex =
        focusedKey === null ? -1 : items.findIndex((item) => item.key === focusedKey)

      if (event.key === 'PageDown' && !event.ctrlKey) {
        const next = items[currentIndex + 1]
        if (next) {
          event.preventDefault()
          void list.scrollToKey(next.key, { align: 'start' }).then(() => {
            focusKey(next.key)
          })
        }
        return
      }

      if (event.key === 'PageUp' && !event.ctrlKey) {
        const previous = items[currentIndex - 1]
        if (previous) {
          event.preventDefault()
          void list.scrollToKey(previous.key, { align: 'start' }).then(() => {
            focusKey(previous.key)
          })
        }
        return
      }

      if (event.ctrlKey && (event.key === 'Home' || event.key === 'End')) {
        event.preventDefault()
        const index = event.key === 'Home' ? 0 : list.count - 1
        void list.scrollToIndex(index, { align: event.key === 'Home' ? 'start' : 'end' })
      }
    },
    [list, focusedKey, focusKey],
  )

  const setSize = totalCount ?? list.count

  return (
    <div
      ref={list.scrollRef}
      className={className}
      style={{ ...SCROLLER_STYLE, ...style }}
      role="feed"
      aria-busy={loading}
      aria-label={label}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
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
      <div ref={list.containerRef} style={CONTAINER_STYLE}>
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
