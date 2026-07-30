import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  VirtualList,
  type VirtualListHandle,
  type ItemKey,
  type VisibilityEvent,
  type SizeSnapshot,
} from 'virtual-anchor/react'
import {
  buildThread,
  estimateCommentSize,
  extendDown,
  extendUp,
  FETCH_LATENCY,
  initialWindow,
  postComments,
  sleep,
  THREAD_SIZE,
  type Comment,
  type Window as ThreadWindow,
} from './thread.js'
import { CONFIG, SNAPSHOT_KEY } from './config.js'
import './styles.css'

/**
 * Where a row's top edge sits inside the scrollport, or null if it is not mounted.
 *
 * The demo measures this itself so the insert controls can report what actually happened
 * rather than claiming it. Same measurement the e2e suite makes.
 */
function rowTop(key: ItemKey): number | null {
  const row = document.querySelector(`[data-virtual-key="${String(key)}"]`)
  const scroller = document.querySelector('.scroller')
  if (!row || !scroller) return null
  return (
    row.getBoundingClientRect().top -
    (scroller.getBoundingClientRect().top + scroller.clientTop)
  )
}

/**
 * Keys of the mounted rows a reader can actually see, top to bottom.
 *
 * The sticky header covers the first `scrollPaddingStart` pixels of the scrollport, and rows
 * hidden behind it are on screen only in the arithmetic sense — treating them as visible put
 * "inserted below" underneath a row nobody could see, so nothing appeared to happen.
 */
/** The sticky header's current height, or zero when there is no header. */
function headerHeightNow(): number {
  return document.querySelector('.header')?.getBoundingClientRect().height ?? 0
}

function keysOnScreen(): string[] {
  const scroller = document.querySelector('.scroller')
  if (!scroller) return []

  const box = scroller.getBoundingClientRect()
  const visibleTop = box.top + headerHeightNow()
  return [...document.querySelectorAll<HTMLElement>('[data-virtual-key]')]
    .filter((row) => {
      const rect = row.getBoundingClientRect()
      return rect.bottom > visibleTop && rect.top < box.bottom
    })
    .map((row) => row.dataset.virtualKey ?? '')
}

export function App(): ReactNode {
  // State rather than a constant: comments arrive while you are reading, which is the whole
  // point of the insert controls below.
  const [thread, setThread] = useState(() => buildThread())
  const postedCount = useRef(0)
  const target = CONFIG.target

  const [window_, setWindow] = useState<ThreadWindow>(() =>
    CONFIG.loadAll ? { from: 0, to: THREAD_SIZE } : initialWindow(target),
  )
  const [loading, setLoading] = useState(false)
  const [events, setEvents] = useState<VisibilityEvent[]>([])
  const [seen, setSeen] = useState<Set<string>>(new Set())
  const [highlighted, setHighlighted] = useState<string | null>(null)

  /**
   * Measured sizes carried across a reload.
   *
   * Read once, before the first render, because a snapshot arriving later has nothing
   * to restore: the sizes it describes have already been estimated and, for anything
   * mounted, measured.
   */
  const [restoredSnapshot] = useState<SizeSnapshot | undefined>(() => {
    if (!CONFIG.snapshot) return undefined
    const raw = sessionStorage.getItem(SNAPSHOT_KEY)
    if (raw === null) return undefined
    try {
      return JSON.parse(raw) as SizeSnapshot
    } catch {
      return undefined
    }
  })
  const [search, setSearch] = useState('')
  /** The comment number typed into the "go to" box, as text so it can be empty. */
  const [target_, setTarget] = useState('')
  /** How many comments the insert buttons post, as text so it can be edited freely. */
  const [insertCount, setInsertCount] = useState('3')
  const [settleInfo, setSettleInfo] = useState<string>('')

  const listRef = useRef<VirtualListHandle>(null)
  const loadingRef = useRef(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLElement>(null)

  /**
   * The sticky header's real height, which is what `scrollPaddingStart` has to be.
   *
   * A narrow window wraps the controls onto a second row, and a deep link that still aimed
   * for the old 64px would land *underneath* the header. Measured rather than assumed, and
   * fed back into the list — which is what any consumer with a responsive sticky header has
   * to do, and a decent demonstration that the option can change at runtime.
   *
   * Starts at the configured value so the first paint aims correctly, before any observation.
   */
  const [headerHeight, setHeaderHeight] = useState(CONFIG.paddingStart)
  useLayoutEffect(() => {
    const header = headerRef.current
    if (!header) return

    const observer = new ResizeObserver(() => {
      setHeaderHeight(header.getBoundingClientRect().height)
    })
    observer.observe(header)
    return () => {
      observer.disconnect()
    }
  }, [])

  /**
   * The measured header slot's height, which the suite can change at will.
   *
   * The point of the slot is that this number is the library's problem, not the
   * consumer's — so the demo changes it and asserts the view did not move,
   * rather than declaring it anywhere the library can read.
   */
  const [headerSlotHeight, setHeaderSlotHeight] = useState(CONFIG.header)

  /**
   * The library's latest at-bottom answer, for the test handle.
   *
   * A ref rather than state: reporting it is the point, and re-rendering the whole
   * demo every time the reader reaches the end would be the demo doing the thing
   * the library exists to avoid.
   */
  const atBottomRef = useRef(true)

  /**
   * When the *page* is the scroller, everything the page renders above the list is part
   * of the scroll offset — so the list's own document offset is exactly what
   * `scrollMargin` means, and leaving it at zero puts every landing out by that much.
   * Here it was 1px, from the header's bottom border.
   *
   * Measured after layout rather than assumed, because a consumer knows its own chrome
   * but not what the box model does with it.
   */
  const [documentOffset, setDocumentOffset] = useState(0)
  useLayoutEffect(() => {
    if (!CONFIG.windowScroller) return
    const host = hostRef.current
    if (host) setDocumentOffset(host.getBoundingClientRect().top + window.scrollY)
  }, [])

  // Latest values for the test handle. Assigned in an effect rather than during
  // render: the handle's `loadOlder` has to read the window *after* a page has been
  // fetched, so closing over the render-time value reports a delta of zero.
  const windowRef = useRef(window_)
  /**
   * How many times each comment has been reported as entering.
   *
   * Also answers "how many distinct comments have been seen", which is why there is no
   * second mirror of the `seen` set here.
   */
  const entersRef = useRef(new Map<string, number>())
  useEffect(() => {
    windowRef.current = window_
  }, [window_])

  const items = useMemo(
    () => thread.slice(window_.from, window_.to),
    [thread, window_.from, window_.to],
  )

  /**
   * Simulated page fetch at either end, with latency.
   *
   * `force` skips the in-flight check, for the test that deliberately breaks the
   * protocol: deferring is what keeps a smooth scroll converging quickly, but the
   * landing must still be correct for a consumer that prepends anyway.
   */
  const loadMore = useCallback(
    async (direction: 'up' | 'down', force = false) => {
      // Never fetch while a programmatic scroll is in flight: a load moves every offset
      // below it, so the target would outrun the animation and the scroll would never
      // settle. This is the protocol the library documents rather than a test hook.
      // With the whole thread loaded there is nothing to page.
      if (CONFIG.loadAll) return
      if (loadingRef.current) return
      if (!force && listRef.current?.isScrolling() === true) return
      const atEdge = direction === 'up' ? window_.from === 0 : window_.to >= THREAD_SIZE
      if (atEdge) return

      loadingRef.current = true
      setLoading(true)
      await sleep(FETCH_LATENCY)
      setWindow((current) => (direction === 'up' ? extendUp(current) : extendDown(current)))
      setLoading(false)
      loadingRef.current = false
    },
    [window_.from, window_.to],
  )

  /** Persist on the way out, which is when a real app would. */
  useEffect(() => {
    if (!CONFIG.snapshot) return
    const persist = (): void => {
      const snapshot = listRef.current?.takeSizeSnapshot()
      if (snapshot) sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot))
    }
    window.addEventListener('pagehide', persist)
    return () => {
      persist()
      window.removeEventListener('pagehide', persist)
    }
  }, [])

  const onVisibilityChange = useCallback((batch: VisibilityEvent[]) => {
    for (const event of batch) {
      if (event.phase !== 'enter') continue
      const key = String(event.key)
      entersRef.current.set(key, (entersRef.current.get(key) ?? 0) + 1)
    }
    setEvents((previous) => [...batch, ...previous].slice(0, 60))
    setSeen((previous) => {
      const next = new Set(previous)
      for (const event of batch) if (event.phase === 'enter') next.add(String(event.key))
      return next
    })
  }, [])

  /** Deep-link on first paint, then flash the target once motion has settled. */
  useEffect(() => {
    const key = `comment-${String(target)}`
    const run = { cancelled: false }

    void (async () => {
      // Two frames, so the first measurements have landed before aiming.
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)
      const result = await listRef.current?.scrollToKey(key, { align: 'start' })
      if (run.cancelled || !result) return

      setSettleInfo(
        `settled=${String(result.settled)} deviation=${result.deviation.toFixed(3)}px iterations=${String(result.iterations)}`,
      )
      setHighlighted(key)
      setTimeout(() => {
        setHighlighted(null)
      }, 1600)
    })()

    return () => {
      run.cancelled = true
    }
  }, [target])

  /**
   * Fetch when either edge comes within a screenful.
   *
   * One callback for both scroller kinds. This used to be two implementations —
   * an `onScroll` handler reading `scrollTop`/`clientHeight`/`scrollHeight` off
   * the element, and a `window` scroll listener doing the same arithmetic against
   * `scrollY`/`innerHeight`/`documentElement`, because the host's `onScroll` never
   * fires when the page is what scrolls. The library knows which one it is, so it
   * is the library's arithmetic to do.
   *
   * The defer-while-scrolling guard is gone with them: `onEdgeReached` does not
   * fire while a programmatic scroll is in flight.
   */
  const onEdgeReached = useCallback(
    (edge: 'start' | 'end') => {
      void loadMore(edge === 'start' ? 'up' : 'down')
    },
    [loadMore],
  )

  /**
   * Insert freshly posted comments at the top or the bottom of what is loaded.
   *
   * "The top of the list" in a windowed list means the start of the loaded slice: the
   * comments go in at that boundary and the window grows to include them, so they appear
   * where you would see them arrive. Everything below them shifts by one index each —
   * which is exactly the case an index-addressed virtual list handles badly and this one is
   * built for.
   *
   * The delta is measured and reported rather than asserted: the claim is that inserting
   * above the viewport does not move what you are reading, and you should be able to *see*
   * that it is zero rather than take my word for it.
   */
  const insertComments = useCallback(
    async (where: 'above' | 'below', requested: number) => {
      // A demo, not a load test: a thousand at a time is already thousands of DOM nodes'
      // worth of measurement, and the point is made long before that.
      const count = Math.min(Math.max(Math.trunc(requested), 1), 1000)
      const anchorKey = listRef.current?.getAnchor()?.key
      const topBefore = anchorKey === undefined ? null : rowTop(anchorKey)

      // Above means above the *anchored* item — the one the library has pinned the view to,
      // which it will tell you — not above whichever row this file thinks is topmost. Those
      // differ by one at a sub-pixel boundary: WebKit anchored to the comment ending exactly
      // at the fold where Chromium anchored to the one starting there, so placing the insert
      // by eye put it below the anchor on one engine and above it on the other. Below means
      // after the last row anyone can see.
      const boundary = where === 'above' ? anchorKey : keysOnScreen().at(-1)

      const posted = postComments(count, ++postedCount.current)
      setThread((current) => {
        const found = boundary === undefined ? -1 : current.findIndex((c) => c.id === boundary)
        const at =
          found < 0
            ? where === 'above'
              ? windowRef.current.from
              : windowRef.current.to
            : found + (where === 'above' ? 0 : 1)


        return [...current.slice(0, at), ...posted, ...current.slice(at)]
      })
      // Both insertion points are inside the loaded slice, so it grows by exactly `count`.
      setWindow((current) => ({ from: current.from, to: current.to + count }))

      // Let the insert reach the list and the anchor be restored from it.
      await new Promise(requestAnimationFrame)
      await new Promise(requestAnimationFrame)

      const topAfter = anchorKey === undefined ? null : rowTop(anchorKey)
      const moved =
        topBefore === null || topAfter === null ? null : Math.abs(topAfter - topBefore)

      setSettleInfo(
        `${String(count)} comment${count === 1 ? '' : 's'} inserted ${where} the view — ` +
          (moved === null
            ? 'nothing anchored to compare'
            : `it moved ${moved.toFixed(3)}px`) +
          ` · scroll ${where === 'above' ? 'up' : 'down'} to see them`,
      )
    },
    [],
  )

  /**
   * A handle for the Playwright suite.
   *
   * The accuracy tests need to drive the *app's* behaviour — widen the loaded
   * window, load a page at either end — not just the library's, because that is
   * what the assertions are about: whether a prepend moves the view. Reaching in
   * through a test handle keeps the assertions honest about what a real consumer
   * does, rather than reimplementing the app inside the test.
   */
  useEffect(() => {
    const handle = {
      scrollToKey: (key: string, options?: Parameters<VirtualListHandle['scrollToKey']>[1]) =>
        listRef.current?.scrollToKey(key, options),
      setWindowAround: (index: number) => {
        setWindow(initialWindow(index))
      },
      /**
       * Prepend a page and report how many comments arrived.
       *
       * `force` skips the defer-while-scrolling protocol, for the test that deliberately
       * breaks it — see `loadMore`.
       */
      loadOlder: async (force = false) => {
        const before = window_.from
        await loadMore('up', force)
        // A forced load is measured mid-animation, so it must not wait for the settle
        // that the unforced path uses to let the window state land.
        if (!force) await sleep(FETCH_LATENCY * 2)
        return before - windowRef.current.from
      },
      loadNewer: async () => {
        const before = window_.to
        await loadMore('down')
        await sleep(FETCH_LATENCY * 2)
        return windowRef.current.to - before
      },
      seenCount: () => entersRef.current.size,
      /**
       * Grow (or shrink) the measured header, and report the height it settled at.
       *
       * The assertion this exists for is that the view does not move by a pixel
       * while it happens — the thing every other virtual list gets wrong when a
       * header loads an image or swaps a font.
       */
      setHeaderHeight: (height: number) => {
        setHeaderSlotHeight(height)
        return height
      },
      /** Post comments at either end of the loaded window; reports how far the view moved. */
      insert: (where: 'above' | 'below', count: number) => insertComments(where, count),
      /** Whether the library currently considers the view to be at the end. */
      isAtBottom: () => atBottomRef.current,
      /** The library's own idea of where the view is pinned. */
      getAnchor: () => listRef.current?.getAnchor() ?? null,
      takeSizeSnapshot: () => listRef.current?.takeSizeSnapshot() ?? null,
      enterCount: (key: string) => entersRef.current.get(key) ?? 0,
      maxEnterCount: () => Math.max(0, ...entersRef.current.values()),
    }
    Object.assign(window, { __list: handle })
  }, [loadMore, insertComments, window_.from, window_.to])

  /**
   * Go to a comment by its position in the whole thread.
   *
   * The one path every control uses, because "scroll to a comment" is one operation with
   * one awkward part: the target is usually *not loaded*. Only a window of the thread is
   * in memory, so the window has to move first and the row has to exist before it can be
   * aimed at — and `scrollToKey` reporting `unknown-key` is exactly how you know it does
   * not yet. Retrying on that is more honest than guessing at a number of frames.
   */
  const goToComment = useCallback(
    async (index: number, align: 'start' | 'end' = 'start') => {
      const clamped = Math.min(Math.max(index, 0), THREAD_SIZE - 1)
      const comment = thread[clamped]
      if (!comment) return

      if (!CONFIG.loadAll) setWindow(initialWindow(clamped))

      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await listRef.current?.scrollToKey(comment.id, { align })
        if (result && result.reason !== 'unknown-key') {
          setHighlighted(comment.id)
          setTimeout(() => {
            setHighlighted(null)
          }, 1600)
          setSettleInfo(
            `#${String(clamped)} — settled=${String(result.settled)} ` +
              `deviation=${result.deviation.toFixed(3)}px iterations=${String(result.iterations)}`,
          )
          return
        }
        // Not loaded yet: the window change has not reached the list. React flushes state
        // updates that originate outside itself asynchronously, so this takes a frame or
        // two rather than none.
        await new Promise(requestAnimationFrame)
      }

      setSettleInfo(`#${String(clamped)} never loaded`)
    },
    [thread],
  )

  /**
   * In-app search, which is the honest mitigation for find-in-page.
   *
   * Ctrl+F cannot reach unmounted comments — no virtual list solves that, since keeping
   * every node in the DOM defeats the purpose. What the library can do is make jumping to
   * a hit exact, which is what this demonstrates.
   */
  const findInThread = useCallback(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') return

    const match = thread.find((comment) =>
      comment.body.some((paragraph) => paragraph.toLowerCase().includes(needle)),
    )
    if (!match) {
      setSettleInfo(`no comment contains ${JSON.stringify(search.trim())}`)
      return
    }
    void goToComment(match.index)
  }, [search, thread, goToComment])

  /** How many to insert: whatever is in the box, or one if it has been emptied. */
  const insertRequested = Math.max(1, Number.parseInt(insertCount.trim(), 10) || 1)

  /** What the "go to" box currently holds, as an index, or null if it is not usable. */
  const requestedIndex = ((): number | null => {
    const parsed = Number.parseInt(target_.trim(), 10)
    return Number.isFinite(parsed) && parsed >= 0 && parsed < THREAD_SIZE ? parsed : null
  })()

  return (
    <div className="app">
      {CONFIG.paddingStart === 0 ? null : (
      <header className="header" ref={headerRef} style={{ minHeight: CONFIG.paddingStart }}>
        <strong>virtual-anchor</strong>
        <span className="muted">
          {THREAD_SIZE.toLocaleString()} comments · loaded {window_.from}–{window_.to}
          {loading ? ' · loading…' : ''}
        </span>
        <span className="controls">
          {/* The ends of the thread, which are the interesting cases: neither is loaded,
              and the last one can only be reached by aligning to the bottom. */}
          <button type="button" onClick={() => void goToComment(0)}>
            First
          </button>
          <button type="button" onClick={() => void goToComment(THREAD_SIZE - 1, 'end')}>
            Last
          </button>

          <label className="go">
            <span className="muted">Go to&nbsp;#</span>
            <input
              type="number"
              min={0}
              max={THREAD_SIZE - 1}
              inputMode="numeric"
              placeholder="8642"
              value={target_}
              onChange={(event) => {
                setTarget(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && requestedIndex !== null) {
                  void goToComment(requestedIndex)
                }
              }}
            />
          </label>
          <button
            type="button"
            disabled={requestedIndex === null}
            onClick={() => {
              if (requestedIndex !== null) void goToComment(requestedIndex)
            }}
          >
            Go
          </button>

          <span className="group" role="group" aria-label="Insert comments">
            {/* Above the view is the case that matters: every index below the insertion
                shifts, and what you are reading must not move. The panel reports by how
                much, so the claim is visible rather than asserted. */}
            <label className="go">
              <span className="muted">Insert</span>
              <input
                type="number"
                min={1}
                max={1000}
                aria-label="How many comments to insert"
                value={insertCount}
                onChange={(event) => {
                  setInsertCount(event.target.value)
                }}
              />
            </label>
            <button type="button" onClick={() => void insertComments('above', insertRequested)}>
              above view
            </button>
            <button type="button" onClick={() => void insertComments('below', insertRequested)}>
              below view
            </button>
          </span>

          <a className="muted" href="/pagination.html">
            pagination demo →
          </a>

          <label className="find">
            <span className="muted">Find</span>
            <input
              placeholder="text in a comment…"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') findInThread()
              }}
            />
          </label>
        </span>
      </header>
      )}

      <main className="body" ref={hostRef}>
        <VirtualList<Comment>
          items={items}
          getItemKey={(comment) => comment.id}
          estimateSize={estimateCommentSize}
          gap={12}
          scrollPaddingStart={CONFIG.paddingStart === 0 ? 0 : headerHeight}
          {...(restoredSnapshot === undefined ? {} : { sizeSnapshot: restoredSnapshot })}
          // Only the page chrome above the component now. Content *inside* the
          // scroller goes in a slot and is measured, so there is no number here
          // to keep in step with it.
          scrollMargin={documentOffset}
          header={
            CONFIG.header === 0 ? undefined : (
              <div
                data-testid="above-list"
                style={{ height: headerSlotHeight, padding: 16, boxSizing: 'border-box' }}
              >
                Thread description, rendered above the list inside the same scroller.
              </div>
            )
          }
          footer={
            CONFIG.footer === 0 ? undefined : (
              <div
                data-testid="below-list"
                style={{ height: CONFIG.footer, padding: 16, boxSizing: 'border-box' }}
              >
                You have reached the end of the thread.
              </div>
            )
          }
          stickyFooter={
            CONFIG.stickyFooter === 0 ? undefined : (
              <div
                data-testid="sticky-composer"
                className="sticky-composer"
                style={{ height: CONFIG.stickyFooter, padding: 16, boxSizing: 'border-box' }}
              >
                Write a reply…
              </div>
            )
          }
          windowScroller={CONFIG.windowScroller}
          totalCount={thread.length}
          firstItemPosition={window_.from + 1}
          loading={loading}
          label="Thread comments"
          ref={listRef}
          className="scroller"
          itemClassName="comment-slot"
          visibility={{
            rule:
              CONFIG.rule === 'edge'
                ? { mode: 'edge', edge: 'end' }
                : { mode: 'fraction', of: 'item', fraction: 0.5 },
            dwellMs: 600,
            dwell: 'continuous',
            once: CONFIG.once,
          }}
          onVisibilityChange={onVisibilityChange}
          onEdgeReached={onEdgeReached}
          followOutput={CONFIG.follow}
          alignToBottom={CONFIG.alignToBottom}
          onAtBottomChange={(atBottom) => {
            atBottomRef.current = atBottom
          }}
          renderItem={(comment) => (
            <article
              className={[
                'comment',
                comment.posted === true ? 'is-posted' : '',
                highlighted === comment.id ? 'is-highlighted' : '',
                seen.has(comment.id) ? 'is-seen' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              data-comment-index={comment.index}
            >
              <div className="meta">
                <span className="author">{comment.author}</span>
                {/* A real permalink, and the only focusable thing *inside* a row: focus
                    landing here still has to pin the row, which is what `closest` is
                    for. Without one, that path had no coverage anywhere. */}
                {comment.posted === true ? (
                  <span className="muted">just posted</span>
                ) : (
                  <a className="muted permalink" href={`?comment=${String(comment.index)}`}>
                    #{comment.index}
                  </a>
                )}
                {seen.has(comment.id) ? <span className="badge">read</span> : null}
              </div>
              {comment.body.map((paragraph, i) => (
                <p key={i}>{paragraph}</p>
              ))}
            </article>
          )}
        />

        <aside className="panel" aria-label="Visibility events">
          <h2>Visibility events</h2>
          <p className="muted small">{settleInfo || 'waiting for the deep link to settle…'}</p>
          <p className="muted small">{seen.size} marked read</p>
          <ol>
            {events.map((event, i) => (
              <li key={`${String(event.key)}-${String(event.at)}-${String(i)}`}>
                <code className={event.phase === 'enter' ? 'enter' : 'leave'}>
                  {event.phase}
                </code>{' '}
                {String(event.key)}{' '}
                <span className="muted">
                  item {(event.itemFraction * 100).toFixed(0)}% · vp{' '}
                  {(event.viewportFraction * 100).toFixed(0)}%
                  {event.measured ? '' : ' · estimated'}
                </span>
              </li>
            ))}
          </ol>
        </aside>
      </main>
    </div>
  )
}
