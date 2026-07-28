import {
  type ReactNode,
  type UIEvent as ReactUIEvent,
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
  type VisibilityEvent,
  type SizeSnapshot,
} from 'react-virtual-anchor'
import {
  buildThread,
  extendDown,
  extendUp,
  FETCH_LATENCY,
  initialWindow,
  sleep,
  THREAD_SIZE,
  type Comment,
  type Window as ThreadWindow,
} from './thread.js'
import { CONFIG, SNAPSHOT_KEY } from './config.js'
import './styles.css'

export function App(): ReactNode {
  const thread = useMemo(() => buildThread(), [])
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
  const [settleInfo, setSettleInfo] = useState<string>('')

  const listRef = useRef<VirtualListHandle>(null)
  const loadingRef = useRef(false)
  const hostRef = useRef<HTMLDivElement>(null)

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
      /** The library's own idea of where the view is pinned. */
      getAnchor: () => listRef.current?.getAnchor() ?? null,
      takeSizeSnapshot: () => listRef.current?.takeSizeSnapshot() ?? null,
      enterCount: (key: string) => entersRef.current.get(key) ?? 0,
      maxEnterCount: () => Math.max(0, ...entersRef.current.values()),
    }
    Object.assign(window, { __list: handle })
  }, [loadMore, window_.from, window_.to, restoredSnapshot])

  /** Fetch when either edge comes within a screenful. */
  const pageAtEdges = useCallback(
    (offset: number, viewport: number, content: number) => {
      if (offset < 600) void loadMore('up')
      else if (content - offset - viewport < 600) void loadMore('down')
    },
    [loadMore],
  )

  const onScroll = useCallback(
    (event: ReactUIEvent<HTMLDivElement>) => {
      const element = event.currentTarget
      pageAtEdges(element.scrollTop, element.clientHeight, element.scrollHeight)
    },
    [pageAtEdges],
  )

  /**
   * The same thing for a window-scrolled list, where `onScroll` on the host never fires
   * because the host does not scroll — the page does. Without this, window mode looked
   * like a library limitation when it was only a missing listener in the demo.
   */
  useEffect(() => {
    if (!CONFIG.windowScroller) return
    const onWindowScroll = (): void => {
      pageAtEdges(window.scrollY, window.innerHeight, document.documentElement.scrollHeight)
    }
    window.addEventListener('scroll', onWindowScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onWindowScroll)
    }
  }, [pageAtEdges])

  /**
   * In-app search, which is the honest mitigation for find-in-page.
   *
   * Ctrl+F cannot reach unmounted comments — no virtual list solves that, since
   * keeping every node in the DOM defeats the purpose. What the library can do is
   * make jumping to a hit exact, which is what this demonstrates.
   */
  const jumpToMatch = useCallback(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') return
    const match = thread.find((comment) =>
      comment.body.some((paragraph) => paragraph.toLowerCase().includes(needle)),
    )
    if (!match) {
      setSettleInfo('no match in thread')
      return
    }

    // The match may be outside the loaded window, so widen it first.
    setWindow(initialWindow(match.index))
    void (async () => {
      await new Promise(requestAnimationFrame)
      const result = await listRef.current?.scrollToKey(match.id, { align: 'start' })
      setHighlighted(match.id)
      setTimeout(() => {
        setHighlighted(null)
      }, 1600)
      if (result) {
        setSettleInfo(
          `jumped to #${String(match.index)} — settled=${String(result.settled)} deviation=${result.deviation.toFixed(3)}px`,
        )
      }
    })()
  }, [search, thread])

  return (
    <div className="app">
      <header className="header" style={{ height: CONFIG.paddingStart }}>
        <strong>react-virtual-anchor</strong>
        <span className="muted">
          {THREAD_SIZE.toLocaleString()} comments · loaded {window_.from}–{window_.to}
          {loading ? ' · loading…' : ''}
        </span>
        <span className="search">
          <input
            aria-label="Search the thread"
            placeholder="Search thread…"
            value={search}
            onChange={(event) => { setSearch(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') jumpToMatch()
            }}
          />
          <button type="button" onClick={jumpToMatch}>
            Jump
          </button>
        </span>
      </header>

      <main className="body" ref={hostRef}>
        <VirtualList<Comment>
          items={items}
          getItemKey={(comment) => comment.id}
          estimateSize={(comment) => 90 + comment.body.length * 70}
          gap={12}
          scrollPaddingStart={CONFIG.paddingStart}
          {...(restoredSnapshot === undefined ? {} : { sizeSnapshot: restoredSnapshot })}
          scrollMargin={CONFIG.scrollMargin + documentOffset}
          // Real content above the list inside the same scroller, which is the layout
          // `scrollMargin` exists for. Its height has to match the option exactly.
          before={
            CONFIG.scrollMargin > 0 ? (
              <div
                data-testid="above-list"
                style={{ height: CONFIG.scrollMargin, padding: 16, boxSizing: 'border-box' }}
              >
                Thread description, rendered above the list inside the same scroller.
              </div>
            ) : undefined
          }
          windowScroller={CONFIG.windowScroller}
          totalCount={THREAD_SIZE}
          firstItemPosition={window_.from + 1}
          loading={loading}
          label="Thread comments"
          ref={listRef}
          className="scroller"
          itemClassName="comment-slot"
          visibility={{
            rule: { mode: 'fraction', of: 'item', fraction: 0.5 },
            dwellMs: 600,
            dwell: 'continuous',
            once: CONFIG.once,
          }}
          onVisibilityChange={onVisibilityChange}
          onScroll={onScroll}
          renderItem={(comment) => (
            <article
              className={[
                'comment',
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
                <a className="muted permalink" href={`?comment=${String(comment.index)}`}>
                  #{comment.index}
                </a>
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
