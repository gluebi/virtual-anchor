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
  setTraceSink,
  type TraceEvent,
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

const DEFAULT_HEADER_HEIGHT = 64

/**
 * The demo is parameterised from the URL so the accuracy suite can drive the whole
 * promised matrix against one build.
 *
 * Without this the suite collapsed to a single axis: `scrollPaddingStart` was always 64,
 * `scrollMargin` always 0, the scroller was always the inner element, and the sub-pixel
 * assertion only ever ran for `align: 'start'`.
 */
interface DemoConfig {
  target: number
  paddingStart: number
  scrollMargin: number
  windowScroller: boolean
  /** Load the entire thread, so targets sit deep in a large window. */
  loadAll: boolean
  /** Report each comment at most once, rather than on every re-entry. */
  once: boolean
  /** Collect the library's trace events into a ring buffer readable from the console. */
  trace: boolean
}

const readConfig = (): DemoConfig => {
  const params = new URLSearchParams(window.location.search)
  const number = (name: string, fallback: number): number => {
    const raw = params.get(name)
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? parsed : fallback
  }

  return {
    target: Math.min(Math.max(number('comment', 0), 0), THREAD_SIZE - 1),
    paddingStart: number('paddingStart', DEFAULT_HEADER_HEIGHT),
    scrollMargin: number('scrollMargin', 0),
    windowScroller: params.get('windowScroller') === '1',
    loadAll: params.get('loadAll') === '1',
    once: params.get('once') === '1',
    trace: params.get('trace') === '1',
  }
}

export function App(): ReactNode {
  const thread = useMemo(() => buildThread(), [])
  const config = useMemo(() => readConfig(), [])

  /**
   * Keep the last few hundred trace events for inspection — `__trace()` in the console,
   * or from a Playwright `evaluate`. A ring buffer rather than `console.log` because the
   * interesting topics fire every frame during a scroll.
   *
   * Installed in a layout effect at the top of the tree so it is in place before the
   * list's first frame, and only when asked for: with no sink the library builds no
   * payloads at all, and in a production build the calls are not compiled in.
   */
  useLayoutEffect(() => {
    if (!config.trace) return
    const buffer: TraceEvent[] = []
    setTraceSink((event) => {
      buffer.push(event)
      if (buffer.length > 3000) buffer.shift()
    })
    Object.assign(window, {
      __trace: (topic?: string) =>
        topic === undefined ? buffer : buffer.filter((event) => event.topic.startsWith(topic)),
      __traceClear: () => {
        buffer.length = 0
      },
    })
    return () => {
      setTraceSink(null)
    }
  }, [config.trace])
  const target = config.target

  const [window_, setWindow] = useState<ThreadWindow>(() =>
    config.loadAll ? { from: 0, to: THREAD_SIZE } : initialWindow(target),
  )
  const [loading, setLoading] = useState(false)
  const [events, setEvents] = useState<VisibilityEvent[]>([])
  const [seen, setSeen] = useState<Set<string>>(new Set())
  const [highlighted, setHighlighted] = useState<string | null>(null)
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
    if (!config.windowScroller) return
    const host = hostRef.current
    if (host) setDocumentOffset(host.getBoundingClientRect().top + window.scrollY)
  }, [config.windowScroller])

  // Latest values for the test handle. Assigned in an effect rather than during
  // render: the handle's `loadOlder` has to read the window *after* a page has been
  // fetched, so closing over the render-time value reports a delta of zero.
  const windowRef = useRef(window_)
  const seenRef = useRef(seen)
  /** How many times each comment has been reported as entering. */
  const entersRef = useRef(new Map<string, number>())
  useEffect(() => {
    windowRef.current = window_
    seenRef.current = seen
  }, [window_, seen])

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
      if (config.loadAll) return
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
    [window_.from, window_.to, config.loadAll],
  )

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
      loadOlder: async () => {
        const before = window_.from
        await loadMore('up')
        await sleep(FETCH_LATENCY * 2)
        return before - windowRef.current.from
      },
      /** Prepend regardless of an in-flight scroll — see `loadMore`'s `force`. */
      forceLoadOlder: async () => {
        const before = window_.from
        await loadMore('up', true)
        return before - windowRef.current.from
      },
      loadNewer: async () => {
        const before = window_.to
        await loadMore('down')
        await sleep(FETCH_LATENCY * 2)
        return windowRef.current.to - before
      },
      seenCount: () => seenRef.current.size,
      /** The library's own idea of where the view is pinned. */
      getAnchor: () => listRef.current?.getAnchor() ?? null,
      enterCount: (key: string) => entersRef.current.get(key) ?? 0,
      maxEnterCount: () => Math.max(0, ...entersRef.current.values()),
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
      <header className="header" style={{ height: config.paddingStart }}>
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
          scrollPaddingStart={config.paddingStart}
          scrollMargin={config.scrollMargin + documentOffset}
          // Real content above the list inside the same scroller, which is the layout
          // `scrollMargin` exists for. Its height has to match the option exactly.
          before={
            config.scrollMargin > 0 ? (
              <div
                data-testid="above-list"
                style={{ height: config.scrollMargin, padding: 16, boxSizing: 'border-box' }}
              >
                Thread description, rendered above the list inside the same scroller.
              </div>
            ) : undefined
          }
          windowScroller={config.windowScroller}
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
            once: config.once,
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
