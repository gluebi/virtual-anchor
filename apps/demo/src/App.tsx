import {
  type ReactNode,
  type UIEvent as ReactUIEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  VirtualList,
  type VirtualListHandle,
  type VisibilityEvent,
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
import './styles.css'

const HEADER_HEIGHT = 64

const targetFromUrl = (): number => {
  const raw = new URLSearchParams(window.location.search).get('comment')
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), THREAD_SIZE - 1) : 0
}

export function App(): ReactNode {
  const thread = useMemo(() => buildThread(), [])
  const target = useMemo(() => targetFromUrl(), [])

  const [window_, setWindow] = useState<ThreadWindow>(() => initialWindow(target))
  const [loading, setLoading] = useState(false)
  const [events, setEvents] = useState<VisibilityEvent[]>([])
  const [seen, setSeen] = useState<Set<string>>(new Set())
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [settleInfo, setSettleInfo] = useState<string>('')

  const listRef = useRef<VirtualListHandle>(null)
  const loadingRef = useRef(false)
  /** Lets the accuracy suite hold the data set still. */
  const paginationEnabled = useRef(true)

  // Latest values for the test handle. Assigned in an effect rather than during
  // render: the handle's `loadOlder` has to read the window *after* a page has been
  // fetched, so closing over the render-time value reports a delta of zero.
  const windowRef = useRef(window_)
  const seenRef = useRef(seen)
  useEffect(() => {
    windowRef.current = window_
    seenRef.current = seen
  }, [window_, seen])

  const items = useMemo(
    () => thread.slice(window_.from, window_.to),
    [thread, window_.from, window_.to],
  )

  /** Simulated page fetch at either end, with latency. */
  const loadMore = useCallback(
    async (direction: 'up' | 'down') => {
      if (loadingRef.current || !paginationEnabled.current) return
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

  const onVisibilityChange = useCallback((batch: VisibilityEvent[]) => {
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
      loadOlder: async () => {
        const before = window_.from
        await loadMore('up')
        await sleep(FETCH_LATENCY * 2)
        return before - windowRef.current.from
      },
      loadNewer: async () => {
        const before = window_.to
        await loadMore('down')
        await sleep(FETCH_LATENCY * 2)
        return windowRef.current.to - before
      },
      seenCount: () => seenRef.current.size,
      setPaginationEnabled: (enabled: boolean) => {
        paginationEnabled.current = enabled
      },
    }
    Object.assign(window, { __list: handle })
  }, [loadMore, window_.from, window_.to])

  const onScroll = useCallback(
    (event: ReactUIEvent<HTMLDivElement>) => {
      const element = event.currentTarget
      if (element.scrollTop < 600) void loadMore('up')
      else if (element.scrollHeight - element.scrollTop - element.clientHeight < 600) {
        void loadMore('down')
      }
    },
    [loadMore],
  )

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
      <header className="header" style={{ height: HEADER_HEIGHT }}>
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

      <main className="body">
        <VirtualList<Comment>
          items={items}
          getItemKey={(comment) => comment.id}
          estimateSize={(comment) => 90 + comment.body.length * 70}
          gap={12}
          scrollPaddingStart={HEADER_HEIGHT}
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
            once: false,
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
                <span className="muted">#{comment.index}</span>
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
