import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { VirtualList, type VirtualListHandle } from 'virtual-anchor/react'
import { appStyleFor } from './config.js'
import { buildThread, estimateCommentSize, sleep, THREAD_SIZE, type Comment } from './thread.js'
import './styles.css'

/**
 * The two ways people paginate a long list, against the same library.
 *
 * They stress opposite things, which is why both are here:
 *
 *  - **Pages** replace the entire key set. There is no anchor to restore — the position the
 *    reader had refers to comments that are no longer loaded — so the list must land at the
 *    top of the new page deterministically rather than try to hold a position that has
 *    ceased to exist.
 *  - **Infinite** keeps everything and appends. Nothing already visible may move, and the
 *    fetch has to respect the one protocol this library asks of a consumer: do not load
 *    while a programmatic scroll is in flight.
 *
 * Named `PaginationDemo` rather than `Pagination` because its entry point is
 * `pagination.tsx`, and on a case-insensitive filesystem `Pagination.tsx` is the same file.
 */

const PER_PAGE = 50
const PAGES = Math.ceil(THREAD_SIZE / PER_PAGE)
/** Distance from the end at which infinite mode fetches the next page. */
const FETCH_MARGIN = 800

type Mode = 'pages' | 'infinite'

export function PaginationDemo(): ReactNode {
  const [thread] = useState(() => buildThread())
  const [mode, setMode] = useState<Mode>('pages')

  /** Pages mode: which page is shown. Infinite mode: how many pages have been appended. */
  const [page, setPage] = useState(0)
  const [loadedPages, setLoadedPages] = useState(1)
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState(`page 1 of ${PAGES.toLocaleString()}`)
  /** How the last programmatic jump landed, kept apart from the fetch commentary. */
  const [landing, setLanding] = useState('')

  const listRef = useRef<VirtualListHandle>(null)
  const loadingRef = useRef(false)
  const headerRef = useRef<HTMLElement>(null)

  /**
   * The sticky header's real height, which is what `scrollPaddingStart` has to be.
   *
   * A narrow window wraps the controls onto another row, and a page change that still aimed
   * for 64px would land underneath the header.
   */
  const [headerHeight, setHeaderHeight] = useState(64)
  const appStyle = appStyleFor(headerHeight)
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

  const items =
    mode === 'pages'
      ? thread.slice(page * PER_PAGE, (page + 1) * PER_PAGE)
      : thread.slice(0, loadedPages * PER_PAGE)

  /**
   * Go to a page, which replaces every item.
   *
   * The scroll happens *after* the new items are in: aiming at index 0 while the keys are on
   * their way out would target an item about to be unmounted. Two frames, because React
   * flushes an update originating outside itself asynchronously.
   */
  const goToPage = useCallback(async (next: number) => {
    const clamped = Math.min(Math.max(next, 0), PAGES - 1)
    setPage(clamped)

    await new Promise(requestAnimationFrame)
    await new Promise(requestAnimationFrame)

    const result = await listRef.current?.scrollToIndex(0, { align: 'start' })
    setStatus(
      `page ${String(clamped + 1)} of ${PAGES.toLocaleString()} — ` +
        (result
          ? `landed at the top, settled=${String(result.settled)} ` +
            `deviation=${result.deviation.toFixed(3)}px`
          : 'no list'),
    )
  }, [])

  /**
   * Infinite mode: append the next page as the end approaches.
   *
   * The defer-while-scrolling half of the protocol is gone from here, because
   * `onEdgeReached` does not fire while a programmatic scroll is in flight — the
   * library refuses to ask at the one moment the answer must be no. What remains
   * is the half that is genuinely a product question: whether a fetch is already
   * running, and whether there is anything left to fetch.
   */
  const loadNextPage = useCallback(async () => {
    if (loadingRef.current) return
    if (loadedPages >= PAGES) {
      setStatus(`all ${PAGES.toLocaleString()} pages loaded`)
      return
    }

    loadingRef.current = true
    setLoading(true)
    setStatus(`fetching page ${String(loadedPages + 1)}…`)

    await sleep(220)
    setLoadedPages((current) => current + 1)
    setLoading(false)
    loadingRef.current = false
    setStatus(`${((loadedPages + 1) * PER_PAGE).toLocaleString()} comments loaded, nothing moved`)
  }, [loadedPages])

  /**
   * Animate to the last loaded comment, which collides with the fetch margin on the way.
   *
   * Reported separately from `status`, because arriving at the end is now
   * immediately followed by a page load — `onEdgeReached` fires the moment the
   * animation settles, which is exactly what infinite scrolling should do and
   * which used to overwrite this line before anyone could read it.
   */
  const jumpToEnd = useCallback(async () => {
    setLanding('jumping…')
    const result = await listRef.current?.scrollToIndex(items.length - 1, {
      align: 'end',
      behavior: 'smooth',
    })
    if (result) {
      setLanding(
        `jumped to the end — settled=${String(result.settled)} ` +
          `deviation=${result.deviation.toFixed(3)}px after ${String(result.iterations)} frames`,
      )
    }
  }, [items.length])

  const onEdgeReached = useCallback(
    (edge: 'start' | 'end') => {
      if (mode !== 'infinite' || edge !== 'end') return
      void loadNextPage()
    },
    [mode, loadNextPage],
  )

  const switchMode = useCallback((next: Mode) => {
    setMode(next)
    setPage(0)
    setLoadedPages(1)
    setStatus(
      next === 'pages'
        ? `page 1 of ${PAGES.toLocaleString()}`
        : `${PER_PAGE.toLocaleString()} comments loaded`,
    )
  }, [])

  return (
    <div className="app app--inner" style={appStyle}>
      <header className="header" ref={headerRef} style={{ minHeight: 64 }}>
        <strong>virtual-anchor</strong>
        <span className="muted">pagination · {THREAD_SIZE.toLocaleString()} comments</span>

        <span className="controls">
          <span className="group" role="group" aria-label="Pagination style">
            <button
              type="button"
              aria-pressed={mode === 'pages'}
              onClick={() => {
                switchMode('pages')
              }}
            >
              Pages
            </button>
            <button
              type="button"
              aria-pressed={mode === 'infinite'}
              onClick={() => {
                switchMode('infinite')
              }}
            >
              Infinite
            </button>
          </span>

          {mode === 'pages' ? (
            <span className="group" role="group" aria-label="Page navigation">
              <button type="button" disabled={page === 0} onClick={() => void goToPage(page - 1)}>
                ‹ Prev
              </button>
              <label className="go">
                <span className="muted">Page</span>
                <input
                  type="number"
                  min={1}
                  max={PAGES}
                  value={page + 1}
                  onChange={(event) => {
                    const parsed = Number.parseInt(event.target.value, 10)
                    if (Number.isFinite(parsed)) void goToPage(parsed - 1)
                  }}
                />
              </label>
              <button
                type="button"
                disabled={page >= PAGES - 1}
                onClick={() => void goToPage(page + 1)}
              >
                Next ›
              </button>
            </span>
          ) : (
            <span className="group">
              <button type="button" disabled={loading} onClick={() => void loadNextPage()}>
                {loading ? 'Loading…' : 'Load next page'}
              </button>
              {/* Animating to the end crosses the fetch margin while the scroll is still in
                  flight, which is the collision the protocol exists for: watch the status
                  say it deferred rather than fetching into a moving target. */}
              <button type="button" onClick={() => void jumpToEnd()}>
                Jump to end
              </button>
            </span>
          )}

          <a className="muted" href="/">
            ← thread demo
          </a>
        </span>
      </header>

      <main className="body">
        <VirtualList<Comment>
          items={items}
          getItemKey={(comment) => comment.id}
          estimateSize={estimateCommentSize}
          gap={12}
          scrollPaddingStart={headerHeight}
          // The whole collection either way, so a screen reader hears "comment 51 of 12,000"
          // rather than "1 of 50" — the page is a fetching detail, not the size of the thread.
          totalCount={THREAD_SIZE}
          firstItemPosition={mode === 'pages' ? page * PER_PAGE + 1 : 1}
          loading={loading}
          label="Comments"
          ref={listRef}
          className="scroller"
          itemClassName="comment-slot"
          onEdgeReached={onEdgeReached}
          edgeReachedThreshold={FETCH_MARGIN}
          renderItem={(comment) => (
            <article className="comment">
              <div className="meta">
                <span className="author">{comment.author}</span>
                <span className="muted" data-comment-index={comment.index}>
                  #{comment.index}
                </span>
              </div>
              {comment.body.map((paragraph, position) => (
                <p key={position}>{paragraph}</p>
              ))}
            </article>
          )}
        />

        <aside className="panel" aria-label="Pagination status">
          <h2>Pagination</h2>
          <p className="small" data-testid="status">
            {status}
          </p>
          {landing !== '' && (
            <p className="small" data-testid="landing">
              {landing}
            </p>
          )}
          <p className="small muted">
            {mode === 'pages'
              ? 'Every item is replaced on a page change. There is no position to preserve — ' +
                'the anchored comment is no longer loaded — so the list lands at the top ' +
                'rather than guessing.'
              : 'Pages are appended and nothing already visible may move. The fetch is skipped ' +
                'while a programmatic scroll is in flight, which is the one protocol the ' +
                'library asks for.'}
          </p>
          <p className="small muted">
            Showing {items.length.toLocaleString()} comment{items.length === 1 ? '' : 's'}
            {mode === 'infinite' ? ` of ${THREAD_SIZE.toLocaleString()}` : ''}.
          </p>
        </aside>
      </main>
    </div>
  )
}
