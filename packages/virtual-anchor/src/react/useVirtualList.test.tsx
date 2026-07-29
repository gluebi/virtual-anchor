import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode, useState, type ReactNode } from 'react'
import { VirtualList, type VirtualListHandle } from './VirtualList.js'
import { layoutSignatureFor, type Engine, type ItemKey } from '../index.js'
import { useVirtualList } from './useVirtualList.js'
import { useItemVisibility } from './useItemVisibility.js'

/**
 * Tests for the React adapter.
 *
 * jsdom reports zero for all layout, so these cannot assert positions — the pixel
 * claims belong to the Playwright suite. What they *can* assert is the adapter's
 * contract with React, which is where its defects were: ref identity stability, one
 * engine per viewport rather than one per StrictMode pass, pins merging rather than
 * replacing, and cleanup actually cleaning up.
 */

interface Comment {
  id: string
  text: string
}

const comments = (count: number, prefix = 'c'): Comment[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}${String(i)}`, text: `body ${String(i)}` }))

/** jsdom has neither observer; the adapter constructs both. */
class NoopResizeObserver implements ResizeObserver {
  static count = 0
  constructor() {
    NoopResizeObserver.count++
  }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class NoopIntersectionObserver implements IntersectionObserver {
  readonly scrollMargin = '0px'
  readonly root = null
  readonly rootMargin = '0px'
  readonly thresholds = [0]
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

beforeEach(() => {
  NoopResizeObserver.count = 0
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
  vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver)
  // A non-zero scrollport, or nothing is ever in range.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => 100_000,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  // Envs as well as globals: a leaked `NODE_ENV=production` makes react-dom load its production
  // build against react's development one, and the mismatch surfaces as an unrelated crash in
  // whichever test happens to run next.
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('VirtualList rendering', () => {
  it('mounts a window of items rather than all of them', () => {
    render(
      <VirtualList
        items={comments(500)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )

    const articles = screen.getAllByRole('article')
    expect(articles.length).toBeGreaterThan(0)
    expect(articles.length).toBeLessThan(60)
  })

  it('describes the whole collection, not the loaded window', () => {
    // A list cannot express "comment 4211 of 12000" while sixty are mounted; the feed
    // pattern can, and `aria-posinset` has to count from the collection's start.
    render(
      <VirtualList
        items={comments(40)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        totalCount={12_000}
        firstItemPosition={4192}
        label="Thread"
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )

    const first = screen.getAllByRole('article')[0]
    expect(first).toHaveAttribute('aria-setsize', '12000')
    expect(first).toHaveAttribute('aria-posinset', '4192')
    expect(screen.getByRole('feed')).toHaveAccessibleName('Thread')
  })

  it('marks the feed busy while a page is loading', () => {
    const { rerender } = render(
      <VirtualList
        items={comments(20)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )
    expect(screen.getByRole('feed')).toHaveAttribute('aria-busy', 'false')

    rerender(
      <VirtualList
        items={comments(20)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        loading
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )
    expect(screen.getByRole('feed')).toHaveAttribute('aria-busy', 'true')
  })

  it('makes items focusable, so the scroll region has keyboard access', () => {
    render(
      <VirtualList
        items={comments(20)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )
    expect(screen.getAllByRole('article')[0]).toHaveAttribute('tabindex', '0')
  })
})

describe('useVirtualList engine lifecycle', () => {
  const Harness = ({ items }: { items: Comment[] }) => {
    const list = useVirtualList({
      items,
      getItemKey: (c) => c.id,
      estimateSize: () => 100,
    })
    return (
      <div ref={list.scrollRef} data-testid="scroller">
        <div ref={list.containerRef}>
          {list.items.map((rendered) => (
            <div key={rendered.key} ref={list.itemRef(rendered.key)} data-testid="row">
              {rendered.item.text}
            </div>
          ))}
        </div>
        <span data-testid="count">{list.items.length}</span>
        <span data-testid="total">{list.count}</span>
      </div>
    )
  }

  it('builds one engine per viewport, not one per StrictMode pass', () => {
    // The engine used to be constructed inside a `setState` updater, which React may run
    // twice — so two were built, only the second kept, and the first leaked its
    // scroller's DOM listeners with nothing holding the handle that could remove them.
    render(
      <StrictMode>
        <Harness items={comments(100)} />
      </StrictMode>,
    )

    // Two observers per engine (the resizer's and the gate's). More than a handful means
    // engines are being built and dropped.
    expect(NoopResizeObserver.count).toBeLessThanOrEqual(4)
  })

  it('renders items and reports the collection size', () => {
    render(<Harness items={comments(100)} />)
    expect(Number(screen.getByTestId('count').textContent)).toBeGreaterThan(0)
    expect(screen.getByTestId('total')).toHaveTextContent('100')
  })

  it('keeps the ref callback identity stable across renders', () => {
    // A changed ref identity makes React run cleanup-and-reattach for every mounted
    // item on every render — a forced layout read and an unobserve/observe pair each.
    const seen: ((element: HTMLElement | null) => void)[] = []

    const Capture = () => {
      const [, force] = useState(0)
      const list = useVirtualList({
        items: comments(100),
        getItemKey: (c) => c.id,
        estimateSize: () => 100,
      })
      const first = list.items[0]
      if (first) seen.push(list.itemRef(first.key))
      return (
        <div ref={list.scrollRef}>
          <div ref={list.containerRef} />
          <button type="button" onClick={() => { force((n) => n + 1); }}>
            render
          </button>
        </div>
      )
    }

    render(<Capture />)
    const before = seen.length
    act(() => {
      screen.getByRole('button').click()
    })

    expect(seen.length).toBeGreaterThan(before)
    // Every capture for the same key is the same function.
    expect(new Set(seen).size).toBe(1)
  })

  it('survives the item list being replaced', () => {
    const { rerender } = render(<Harness items={comments(100)} />)
    expect(() => {
      rerender(<Harness items={comments(100, 'other')} />)
    }).not.toThrow()
    expect(Number(screen.getByTestId('count').textContent)).toBeGreaterThan(0)
  })

  it('renders nothing but does not throw for an empty list', () => {
    render(<Harness items={[]} />)
    expect(screen.getByTestId('count')).toHaveTextContent('0')
    expect(screen.getByTestId('total')).toHaveTextContent('0')
  })
})

describe('VirtualList imperative handle', () => {
  const setup = () => {
    const ref = { current: null as VirtualListHandle | null }
    render(
      <VirtualList
        items={comments(500)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        ref={ref}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )
    return ref
  }

  it('exposes the documented surface', () => {
    const ref = setup()
    expect(ref.current).not.toBeNull()
    expect(ref.current?.scrollToKey).toBeTypeOf('function')
    expect(ref.current?.scrollToIndex).toBeTypeOf('function')
    expect(ref.current?.getAnchor).toBeTypeOf('function')
    expect(ref.current?.setAnchor).toBeTypeOf('function')
    expect(ref.current?.takeSizeSnapshot).toBeTypeOf('function')
  })

  it('reports an anchor once mounted', () => {
    const ref = setup()
    expect(ref.current?.getAnchor()?.key).toBe('c0')
  })

  it('reports whether a programmatic scroll is in flight', () => {
    // The fetching contract's half of the handle: a consumer checks this in `onScroll` before
    // loading a page, so it has to answer at rest as well as in motion.
    const ref = setup()
    expect(ref.current?.isScrolling()).toBe(false)
  })

  it('leaves focus alone when focusOnScrollEnd is off', async () => {
    // The option exists so a permalink can move the view without stealing focus from whatever
    // the reader was doing.
    const ref = { current: null as VirtualListHandle | null }
    render(
      <VirtualList
        items={comments(500)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        focusOnScrollEnd={false}
        ref={ref}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )

    const before = document.activeElement
    await act(async () => {
      await ref.current?.scrollToKey('c3')
    })

    expect(document.activeElement).toBe(before)
  })

  it('round-trips a size snapshot', () => {
    const ref = setup()
    const snapshot = ref.current?.takeSizeSnapshot()
    expect(snapshot?.version).toBe(1)
    expect(Array.isArray(snapshot?.sizes)).toBe(true)
  })

  it('reports unknown-key for a key outside the loaded window', async () => {
    const ref = setup()
    await expect(ref.current?.scrollToKey('not-loaded')).resolves.toMatchObject({
      settled: false,
      reason: 'unknown-key',
    })
  })
})

describe('useItemVisibility', () => {
  it('reports a default before anything is known, then the engine value', () => {
    const seen: boolean[] = []

    const Row = ({ engine, itemKey }: { engine: null | Parameters<typeof useItemVisibility>[0]; itemKey: string }) => {
      const visibility = useItemVisibility(engine, itemKey)
      seen.push(visibility.visible)
      return <span data-testid="seen">{String(visibility.hasBeenSeen)}</span>
    }

    const Harness = () => {
      const list = useVirtualList({
        items: comments(100),
        getItemKey: (c) => c.id,
        estimateSize: () => 100,
      })
      return (
        <div ref={list.scrollRef}>
          <div ref={list.containerRef} />
          <Row engine={list.engine} itemKey="c0" />
        </div>
      )
    }

    render(<Harness />)
    // Called with a null engine on the first pass, then with the real one.
    expect(seen.length).toBeGreaterThan(0)
    expect(screen.getByTestId('seen')).toBeInTheDocument()
  })

  it('reports nothing visible when handed no engine', () => {
    const Row = () => {
      const visibility = useItemVisibility(null, 'c0')
      return <span data-testid="v">{String(visibility.visible)}</span>
    }
    render(<Row />)
    expect(screen.getByTestId('v')).toHaveTextContent('false')
  })
})

describe('VirtualList focus pinning', () => {
  it('keeps a consumer-supplied pin when an item takes focus', () => {
    // Replacing rather than merging meant a single click into the feed silently
    // unmounted every key the consumer had pinned.
    render(
      <VirtualList
        items={comments(500)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        keepMounted={['c400']}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )

    expect(screen.getByText('body 400')).toBeInTheDocument()

    const first = screen.getAllByRole('article')[0]!
    act(() => {
      first.focus()
    })

    // Still pinned after focus moved into the list.
    expect(screen.getByText('body 400')).toBeInTheDocument()
  })

  it('pins the row when focus lands on something inside it', () => {
    // Only the row carries the key, so reading the target's own dataset missed focus
    // landing on a link or button within a row — leaving the worst keyboard bug unfixed
    // for any row with interactive content.
    render(
      <VirtualList
        items={comments(500)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        renderItem={(c) => <button type="button">{c.text}</button>}
      />,
    )

    const inner = screen.getByRole('button', { name: 'body 1' })
    act(() => {
      inner.focus()
    })
    expect(document.activeElement).toBe(inner)
  })

  it('ignores focus landing inside the scroller but outside any row', () => {
    // The `before` slot is inside the scrollport, so a filter input there takes focus without
    // there being a row to pin — and pinning `undefined` would be worse than pinning nothing.
    render(
      <VirtualList
        items={comments(500)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        before={<input aria-label="filter" />}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )

    const filter = screen.getByLabelText('filter')
    expect(() => {
      act(() => {
        filter.focus()
      })
    }).not.toThrow()
    expect(document.activeElement).toBe(filter)
  })

  it('releases the pin when focus leaves the feed entirely', () => {
    // Only then: moving between rows must keep the pin, or paging with the keyboard unmounts
    // the row it just left.
    render(
      <>
        <VirtualList
          items={comments(500)}
          getItemKey={(c) => c.id}
          estimateSize={() => 100}
          keepMounted={['c400']}
          renderItem={(c) => <span>{c.text}</span>}
        />
        <button type="button">outside</button>
      </>,
    )

    const row = screen.getAllByRole('article')[0]!
    act(() => {
      row.focus()
    })

    const outside = screen.getByRole('button', { name: 'outside' })
    act(() => {
      outside.focus()
    })

    // The consumer's own pin survives; only the focus pin was released.
    expect(document.activeElement).toBe(outside)
    expect(screen.getByText('body 400')).toBeInTheDocument()
  })
})

describe('cleanup', () => {
  it('disconnects its observers on unmount', () => {
    const disconnect = vi.spyOn(NoopResizeObserver.prototype, 'disconnect')
    const { unmount } = render(
      <VirtualList
        items={comments(100)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )

    unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it('removes its document listeners on unmount', () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    const { unmount } = render(
      <VirtualList
        items={comments(100)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )

    unmount()
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })
})

describe('VirtualList keyboard navigation', () => {
  const list = () => (
    <VirtualList
      items={comments(500)}
      getItemKey={(c) => c.id}
      estimateSize={() => 100}
      label="Thread"
      renderItem={(c) => (
        <span>
          {c.text} <a href="#somewhere">permalink</a>
        </span>
      )}
    />
  )

  /** The row a focused element belongs to, however deep the focus landed. */
  const focusedRow = (): string | null =>
    document.activeElement?.closest<HTMLElement>('[data-virtual-key]')?.dataset.virtualKey ??
    null

  const press = async (key: string, options: KeyboardEventInit = {}): Promise<void> => {
    const target = document.activeElement ?? screen.getByRole('feed')
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }))
      await Promise.resolve()
    })
  }

  /**
   * Focus moves when the scroll *settles*, not when the key is pressed — that is the
   * point of it, so that a screen reader announces a position that has stopped moving.
   * So the assertion waits for the convergence loop rather than a microtask.
   */
  const expectFocusedRow = (key: string): Promise<void> =>
    vi.waitFor(
      () => {
        expect(focusedRow()).toBe(key)
      },
      { timeout: 4000, interval: 20 },
    )

  it('moves focus to the next and previous article', async () => {
    render(list())
    const rows = document.querySelectorAll<HTMLElement>('[data-virtual-key]')
    act(() => {
      rows[2]?.focus()
    })
    expect(focusedRow()).toBe('c2')

    await press('PageDown')
    await expectFocusedRow('c3')

    await press('PageUp')
    await expectFocusedRow('c2')
  })

  it('moves focus, not just the view, on ctrl+End and ctrl+Home', async () => {
    // These used to scroll and leave focus behind, so the next PageDown continued from
    // the abandoned position and that row stayed pinned and mounted for good.
    render(list())
    const rows = document.querySelectorAll<HTMLElement>('[data-virtual-key]')
    act(() => {
      rows[1]?.focus()
    })

    await press('End', { ctrlKey: true })
    await expectFocusedRow('c499')

    await press('Home', { ctrlKey: true })
    await expectFocusedRow('c0')
  })

  it('pins the row when focus lands on something inside it', async () => {
    // `closest`, not the target's own dataset: a permalink or reply button inside a
    // comment has to pin its row too, or a keyboard user loses their place the moment
    // they reach for it.
    render(list())
    const link = document.querySelectorAll<HTMLElement>('[data-virtual-key] a')[3]
    act(() => {
      link?.focus()
    })

    expect(document.activeElement?.tagName).toBe('A')
    expect(focusedRow()).toBe('c3')

    // And it survives a move far past any buffer.
    await press('End', { ctrlKey: true })
    expect(document.querySelector('[data-virtual-key="c3"]')).not.toBeNull()
  })

  it('starts paging from what is on screen when nothing holds focus', async () => {
    // Dispatched at the feed rather than at `document.body`, because a key event outside
    // the feed never reaches its handler — this is the case where a consumer has focused
    // the scrollport itself, or forwards keys to it from a parent.
    render(list())
    const feed = screen.getByRole('feed')
    await act(async () => {
      feed.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }))
      await Promise.resolve()
    })
    await expectFocusedRow('c1')
  })
})

describe('sizeSnapshot through the component', () => {
  it('restores measured sizes, so the content height reflects them', () => {
    // The regression test for a feature that did nothing at all: `sizeSnapshot` was
    // forwarded only through `setOptions`, which had no handler for it, and was never
    // passed at construction — where the cache actually reads it. So the option was
    // accepted, documented, unit-tested at the engine level, and inert through React.
    const handle = { current: null as VirtualListHandle | null }
    const { unmount } = render(
      <VirtualList
        ref={handle}
        items={comments(100)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )

    // The signature has to match the environment the snapshot is restored into, so it is
    // taken from the live list rather than guessed.
    const signature = handle.current?.takeSizeSnapshot().layoutSignature ?? ''
    expect(signature).not.toBe('')
    unmount()
    cleanup()

    const restored = render(
      <VirtualList
        items={comments(100)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        sizeSnapshot={{
          version: 1,
          layoutSignature: signature,
          estimate: 100,
          // Ten comments at 400px instead of the estimated 100.
          sizes: Array.from({ length: 10 }, (_, i) => [`c${String(i)}`, 400] as const),
        }}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )

    // 10 × 400 + 90 × 100 = 13,000, against 10,000 with the snapshot ignored.
    const feed = restored.container.querySelector<HTMLElement>('[role="feed"]')
    expect(feed?.style.height).toBe('13000px')
  })

  it('ignores a snapshot from a different layout', () => {
    // Compared against the same list with no snapshot at all, rather than a hardcoded
    // number: what matters is that a refused snapshot changes *nothing*.
    const plain = render(
      <VirtualList
        items={comments(100)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )
    const baseline = plain.container.querySelector<HTMLElement>('[role="feed"]')?.style.height
    plain.unmount()
    cleanup()

    const withStaleSnapshot = render(
      <VirtualList
        items={comments(100)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        sizeSnapshot={{
          version: 1,
          layoutSignature: 'measured-at-some-other-width',
          estimate: 100,
          sizes: Array.from({ length: 10 }, (_, i) => [`c${String(i)}`, 400] as const),
        }}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )

    // A height measured at a different width is wrong rather than stale, so it is
    // refused outright and every item keeps its estimate.
    expect(
      withStaleSnapshot.container.querySelector<HTMLElement>('[role="feed"]')?.style.height,
    ).toBe(baseline)
  })
})

describe('VirtualList keyboard navigation, edges', () => {
  const list = () => (
    <VirtualList
      items={comments(50)}
      getItemKey={(c) => c.id}
      estimateSize={() => 100}
      label="Thread"
      renderItem={(c) => <span>{c.text}</span>}
    />
  )

  const send = async (key: string, options: KeyboardEventInit = {}): Promise<boolean> => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
    await act(async () => {
      ;(document.activeElement ?? screen.getByRole('feed')).dispatchEvent(event)
      await Promise.resolve()
    })
    return event.defaultPrevented
  }

  it('ignores keys it does not handle', async () => {
    render(list())
    const rows = document.querySelectorAll<HTMLElement>('[data-virtual-key]')
    act(() => {
      rows[3]?.focus()
    })

    // Not consumed: a consumer's own shortcuts, and the browser's, must keep working.
    expect(await send('ArrowDown')).toBe(false)
    expect(await send('a')).toBe(false)
    // A modifier the contract does not claim, on a key it does.
    expect(await send('PageDown', { ctrlKey: true })).toBe(false)
    expect(await send('f', { ctrlKey: true })).toBe(false)
  })

  it('does nothing at the ends of the collection', async () => {
    // Off the end in either direction resolves to no key at all, which is what handles
    // both boundaries without either branch needing its own bound check.
    render(list())
    const rows = document.querySelectorAll<HTMLElement>('[data-virtual-key]')

    act(() => {
      rows[0]?.focus()
    })
    expect(await send('PageUp')).toBe(false)
  })
})

describe('useVirtualList before a scroller exists', () => {
  it('answers safely for every accessor', () => {
    // The element arrives via a ref callback, so the first render has no engine at all.
    // Every accessor has to be callable then — a consumer's effect can run before it.
    interface Probed {
      keyAt: ItemKey | undefined
      focusItem: boolean
      count: number
      anchor: unknown
      snapshotSizes: number
      scrolling: boolean
    }
    let probed: Probed | null = null

    const Probe = (): ReactNode => {
      const list = useVirtualList({ items: comments(10), getItemKey: (c) => c.id })
      probed = {
        keyAt: list.keyAt(3),
        focusItem: list.focusItem('c3'),
        count: list.count,
        anchor: list.getAnchor(),
        snapshotSizes: list.takeSizeSnapshot().sizes.length,
        scrolling: list.scrolling,
      }
      // Never rendered into a scroller, so `scrollRef` is never called.
      return null
    }

    render(<Probe />)

    expect(probed).toEqual({
      keyAt: undefined,
      focusItem: false,
      // The collection, not the mounted set — that is known before any scroller is.
      count: 10,
      anchor: null,
      snapshotSizes: 0,
      scrolling: false,
    })
  })

  it('sets an anchor without a scroller without throwing', () => {
    const handle = { current: null as VirtualListHandle | null }
    render(
      <VirtualList
        ref={handle}
        items={comments(10)}
        getItemKey={(c) => c.id}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )

    expect(() => {
      handle.current?.setAnchor({ key: 'c3', offsetWithinItem: 0 })
    }).not.toThrow()
  })
})

describe('useVirtualList before an engine exists', () => {
  /**
   * Everything the hook returns has to work on the first render, when there is no engine yet.
   *
   * In element-scroller mode that render always happens — the scrollport ref has not fired, so
   * the engine cannot have been derived. A consumer calling into the hook from an event handler
   * that early is unusual but entirely legal, and the fallbacks are what keep it from throwing.
   */
  const capture = () => {
    const first: { list?: ReturnType<typeof useVirtualList<Comment>> } = {}

    const Harness = () => {
      const list = useVirtualList({
        items: comments(100),
        getItemKey: (c) => c.id,
      })
      first.list ??= list
      return <div ref={list.scrollRef} />
    }

    render(<Harness />)
    return first
  }

  it('resolves scrollToKey with an empty result', async () => {
    const first = capture()
    await expect(first.list?.scrollToKey('c0')).resolves.toMatchObject({
      settled: false,
      reason: 'empty',
    })
  })

  it('resolves scrollToIndex with an empty result', async () => {
    const first = capture()
    await expect(first.list?.scrollToIndex(0)).resolves.toMatchObject({
      settled: false,
      reason: 'empty',
    })
  })

  it('hands out an inert item ref', () => {
    const first = capture()
    const ref = first.list?.itemRef('c0')
    // Returns nothing at all, so React 19 reads no cleanup from it.
    expect(ref?.(document.createElement('div'))).toBeUndefined()
  })

  it('reports an empty visible range', () => {
    const first = capture()
    expect(first.list?.getVisibleRange()).toEqual([0, -1])
  })
})

describe('useVirtualList render-storm detector', () => {
  /** A list whose mounted window shifts on every scroll, so every publish needs a render. */
  const Harness = () => {
    const list = useVirtualList({
      items: comments(2000),
      getItemKey: (c) => c.id,
    })
    return (
      <div ref={list.scrollRef} data-testid="scroller">
        <div ref={list.containerRef}>
          {list.items.map((rendered) => (
            <div key={rendered.key} ref={list.itemRef(rendered.key)} />
          ))}
        </div>
      </div>
    )
  }

  /** One publish per iteration, each moving the rendered range so `needsRerender` is true. */
  const storm = (times: number) => {
    const scroller = screen.getByTestId('scroller')
    act(() => {
      for (let i = 1; i <= times; i++) {
        scroller.scrollTop = i * 200
        scroller.dispatchEvent(new Event('scroll'))
      }
    })
  }

  it('complains once when publishes outpace any real scroll', () => {
    // The microtask hop means React's own "Maximum update depth exceeded" cannot fire here, so
    // a publish→render→publish cycle would spin in silence. This is the replacement, and it had
    // no coverage: the threshold branch was never crossed.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Harness />)

    storm(700)

    const storms = error.mock.calls.filter((call) => String(call[0]).includes('store-driven renders'))
    // Once, not seven hundred times — the warning is rate-limited to one per second.
    expect(storms).toHaveLength(1)
  })

  it('says nothing in a production build', () => {
    // The detector is development-only, and the guard around it is the branch a production
    // bundle takes. Stubbed rather than trusted, since nothing else in the suite runs that way.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('NODE_ENV', 'production')
    render(<Harness />)

    storm(700)

    expect(
      error.mock.calls.filter((call) => String(call[0]).includes('store-driven renders')),
    ).toHaveLength(0)
  })
})

describe('useVirtualList server rendering', () => {
  it('renders without a DOM, from the server snapshot', async () => {
    // `useSyncExternalStore` takes a third argument for exactly this, and it is a separate code
    // path from the client snapshot — one that throws on the server if it touches the DOM.
    const { renderToString } = await import('react-dom/server')

    const Harness = () => {
      const list = useVirtualList({
        items: comments(10),
        getItemKey: (c) => c.id,
      })
      return <div ref={list.scrollRef}>{list.items.length}</div>
    }

    expect(renderToString(<Harness />)).toContain('0')
  })
})

describe('estimateSize through the component', () => {
  const rowTops = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('[data-virtual-key]')].map((row) => row.style.top)

  it('positions rows by the estimate it was given', () => {
    // Issue #8. The cache read this option in its constructor only and `setOptions` never
    // forwarded it, while the adapter supplies options exclusively that way — so the estimate
    // was accepted, never called, and every row was laid out at the 120px internal default.
    const estimateSize = vi.fn(() => 250)
    const { container } = render(
      <VirtualList
        items={comments(200)}
        getItemKey={(c) => c.id}
        estimateSize={estimateSize}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )

    expect(estimateSize).toHaveBeenCalled()
    expect(rowTops(container).slice(0, 3)).toEqual(['0px', '250px', '500px'])
  })

  it('honours defaultEstimate for a key the estimator declines', () => {
    // A hole in the collection: the estimator has no item to size, so the fallback applies —
    // and it is the cache's fallback, not a second copy of the number in the adapter.
    const withHole: (Comment | undefined)[] = [...comments(40)]
    withHole[1] = undefined

    const { container } = render(
      <VirtualList
        items={withHole}
        getItemKey={(c, index) => c?.id ?? `hole-${String(index)}`}
        estimateSize={(c) => (c === undefined ? 0 : 300)}
        defaultEstimate={70}
        renderItem={(c) => <span>{c?.text ?? 'nothing'}</span>}
      />,
    )

    // Item 0 is 300 tall; the hole occupies 300..370 at the fallback estimate but renders no
    // row of its own, so the next row present is item 2 at 370 and item 3 at 670.
    expect(rowTops(container).slice(0, 3)).toEqual(['0px', '370px', '670px'])
  })

  it('does not re-estimate every row when the call site passes a fresh closure', () => {
    // The cache compares the estimator by reference to decide whether to rebuild its offset
    // tree — and a call site naturally writes an inline arrow, which is a new function every
    // render. Keying the adapter's wrapper on that identity rebuilt every slot, republished and
    // re-aimed any in-flight scroll on each render; the e2e accuracy matrix failed by a pixel.
    // So the arrow here is deliberate, and a stable `vi.fn` would not catch the regression.
    const counted = vi.fn(() => 250)
    // Hoisted, so the reference is stable across renders. An `items` array rebuilt inline in
    // JSX churns the key set too, and `setKeys` then rebuilds regardless of the estimator —
    // which is pre-existing behaviour, and would make this test prove nothing.
    const stable = comments(2000)

    const Harness = () => {
      const [n, force] = useState(0)
      return (
        <>
          <button type="button" onClick={() => { force((v) => v + 1); }}>
            render
          </button>
          <VirtualList
            items={stable}
            getItemKey={(c) => c.id}
            estimateSize={() => counted()}
            totalCount={2000 + n}
            renderItem={(c) => <span>{c.text}</span>}
          />
        </>
      )
    }

    render(<Harness />)
    const afterMount = counted.mock.calls.length
    expect(afterMount).toBeGreaterThan(0)

    act(() => {
      screen.getByRole('button').click()
    })

    // A rebuild would call the estimator once per item — two thousand of them.
    expect(counted.mock.calls.length - afterMount).toBeLessThan(200)
  })
})

describe('useVirtualList option plumbing', () => {
  it('accepts the geometry options together', () => {
    // Each is spread conditionally, so a list that sets none of them leaves three branches
    // untaken — and `scrollMargin` in particular had no adapter-level coverage at all.
    expect(() => {
      render(
        <VirtualList
          items={comments(100)}
          getItemKey={(c) => c.id}
          scrollPaddingStart={64}
          scrollPaddingEnd={32}
          scrollMargin={120}
          gap={8}
          buffer={200}
          defaultEstimate={100}
          keepMounted={['c50']}
          visibility={{ rule: { mode: 'any' } }}
          sizeSnapshot={{ version: 1, layoutSignature: '', estimate: 100, sizes: [] }}
          before={<p>above the list</p>}
          renderItem={(c) => <span>{c.text}</span>}
        />,
      )
    }).not.toThrow()

    expect(screen.getByText('above the list')).toBeInTheDocument()
  })

  it('skips items the key function cannot resolve', () => {
    // A hole in the collection: the key set still covers the index, so the engine may mount it,
    // but there is no item to render — which must be skipped rather than rendered as `undefined`.
    const withHole: (Comment | undefined)[] = [...comments(40)]
    withHole[3] = undefined

    render(
      <VirtualList
        items={withHole}
        getItemKey={(c, index) => c?.id ?? `hole-${String(index)}`}
        renderItem={(c) => <span>{c?.text ?? 'nothing'}</span>}
      />,
    )

    expect(screen.queryByText('nothing')).not.toBeInTheDocument()
    expect(screen.getByText('body 4')).toBeInTheDocument()
  })
})

describe('windowScroller through the component', () => {
  it('builds an engine against the document rather than a scrollport', () => {
    // The host must not scroll as well — the DOM shape and the viewport choice used to be
    // decided independently, giving a nested scroller inside a window-scrolled list.
    const { container } = render(
      <VirtualList
        items={comments(100)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        windowScroller
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )

    const host = container.firstElementChild as HTMLElement | null
    expect(host?.style.overflowY).toBe('')
    // The engine exists immediately: the window needs no ref, so items render on the
    // first commit rather than the second.
    expect(container.querySelectorAll('[data-virtual-key]').length).toBeGreaterThan(0)
  })
})

describe('VirtualList scrollerRef', () => {
  const list = (props: Partial<Parameters<typeof VirtualList<Comment>>[0]>) => (
    <VirtualList
      items={comments(100)}
      getItemKey={(c) => c.id}
      estimateSize={() => 100}
      renderItem={(c) => <span>{c.text}</span>}
      {...props}
    />
  )

  it('hands over the scrollport node through an object ref', () => {
    const scroller = { current: null as HTMLElement | null }
    const { container } = render(list({ scrollerRef: scroller }))

    expect(scroller.current).toBe(container.firstElementChild)
    // And the list still works, so the composed ref did not displace `list.scrollRef`.
    expect(container.querySelectorAll('[data-virtual-key]').length).toBeGreaterThan(0)
  })

  it('hands over the scrollport node through a callback ref', () => {
    const seen: (HTMLElement | null)[] = []
    const { container } = render(list({ scrollerRef: (element) => { seen.push(element) } }))

    expect(seen).toContain(container.firstElementChild)
  })

  it('runs a callback ref’s own cleanup rather than discarding it', () => {
    // React 19 lets a ref callback return its teardown. Ignoring that would silently leak
    // whatever the consumer attached to the node.
    const released: string[] = []
    const { unmount } = render(
      list({
        scrollerRef: () => () => {
          released.push('cleanup')
        },
      }),
    )

    expect(released).toEqual([])
    unmount()
    expect(released).toEqual(['cleanup'])
  })

  it('resolves the page scroller under windowScroller', () => {
    // The host div is not a scrollport in this mode, so handing it over would be a lie. The
    // page is what scrolls, and that is what a consumer needs to attach to.
    const scroller = { current: null as HTMLElement | null }
    const { container } = render(list({ windowScroller: true, scrollerRef: scroller }))

    // `scrollingElement` is null on a document with no browsing context, which jsdom is; the
    // fallback is what keeps the ref from being uselessly empty there.
    expect(scroller.current).toBe(document.scrollingElement ?? document.documentElement)
    expect(scroller.current).not.toBe(container.firstElementChild)
  })

  it('hands over the same element the engine fingerprints', () => {
    // The node a consumer receives and the element the library measures its layout against used
    // to be resolved separately: this test asserted only that the ref got `body`, while the
    // adapter went on fingerprinting `documentElement`. It now asserts they agree, which is the
    // whole point of #12 — and it is the assertion that fails if only one of the two sites moves.
    //
    // Defined rather than spied: jsdom does not expose this as a configurable accessor for
    // `vi.spyOn` to wrap, and reports `null` by default so the fallback is otherwise the only
    // path ever exercised.
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'scrollingElement')
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true,
      get: () => document.body,
    })
    // jsdom reports zero width for everything, so without this the two candidate elements
    // fingerprint identically and the assertion below could not tell them apart.
    Object.defineProperty(document.body, 'clientWidth', { configurable: true, get: () => 777 })

    try {
      const scroller = { current: null as HTMLElement | null }
      const captured: { engine?: Engine } = {}
      render(
        list({
          windowScroller: true,
          scrollerRef: scroller,
          onEngineReady: (next) => {
            if (next) captured.engine ??= next
          },
        }),
      )

      expect(scroller.current).toBe(document.body)
      const signature = captured.engine?.cache.layoutSignature
      expect(signature).toBe(layoutSignatureFor(document.body))
      // And emphatically not the element it merely scopes measurements to.
      expect(signature).not.toBe(layoutSignatureFor(document.documentElement))
    } finally {
      delete (document as unknown as Record<string, unknown>).scrollingElement
      delete (document.body as unknown as Record<string, unknown>).clientWidth
      if (original) Object.defineProperty(Document.prototype, 'scrollingElement', original)
    }
  })

  it('publishes and releases the same way in both modes', () => {
    // Two mechanisms for one prop meant two lifetimes: element mode published in the ref phase,
    // window mode from an effect. A future node-shaped prop would have copied whichever it found.
    for (const windowScroller of [false, true]) {
      const scroller = { current: null as HTMLElement | null }
      const { unmount } = render(list({ windowScroller, scrollerRef: scroller }))

      expect(scroller.current, `mode windowScroller=${String(windowScroller)}`).not.toBeNull()
      unmount()
      expect(scroller.current, `mode windowScroller=${String(windowScroller)}`).toBeNull()
    }
  })

  it('does not rebuild the engine when the ref identity changes', () => {
    // The regression this design exists to prevent. `list.scrollRef` sets the state the engine
    // is derived from, so a composed ref whose identity changed would have React detach and
    // reattach it — disposing and rebuilding the engine on every render.
    const Capture = () => {
      const [n, force] = useState(0)
      return (
        <>
          <button type="button" onClick={() => { force((v) => v + 1); }}>
            render
          </button>
          {/* A fresh arrow every render, which is what a call site will naturally write. */}
          {list({ scrollerRef: (element) => void element, totalCount: 100 + n })}
        </>
      )
    }

    render(<Capture />)
    const before = NoopResizeObserver.count

    act(() => {
      screen.getByRole('button').click()
    })
    act(() => {
      screen.getByRole('button').click()
    })

    expect(NoopResizeObserver.count).toBe(before)
  })

  it('releases the node when the list unmounts', () => {
    const scroller = { current: null as HTMLElement | null }
    const { unmount } = render(list({ scrollerRef: scroller }))
    expect(scroller.current).not.toBeNull()

    unmount()
    expect(scroller.current).toBeNull()
  })
})

describe('VirtualList onEngineReady', () => {
  it('hands over an engine and takes it back on unmount', () => {
    const seen: (null | ReturnType<typeof useVirtualList<Comment>>['engine'])[] = []

    const { unmount } = render(
      <VirtualList
        items={comments(100)}
        getItemKey={(c) => c.id}
        estimateSize={() => 100}
        onEngineReady={(engine) => { seen.push(engine) }}
        renderItem={(c) => <span>{c.text}</span>}
      />,
    )

    expect(seen.some((engine) => engine !== null)).toBe(true)

    unmount()
    // `null` last, so a consumer holding it in state cannot keep subscribing to a disposed one.
    expect(seen.at(-1)).toBeNull()
  })

  it('feeds useItemVisibility, which no component consumer could reach before', () => {
    const Row = ({ engine }: { engine: Parameters<typeof useItemVisibility>[0] }) => {
      const visibility = useItemVisibility(engine, 'c0')
      return <span data-testid="v">{String(visibility.visible)}</span>
    }

    const Harness = () => {
      const [engine, setEngine] = useState<Parameters<typeof useItemVisibility>[0]>(null)
      return (
        <>
          <VirtualList
            items={comments(100)}
            getItemKey={(c) => c.id}
            estimateSize={() => 100}
            onEngineReady={setEngine}
            renderItem={(c) => <span>{c.text}</span>}
          />
          <Row engine={engine} />
        </>
      )
    }

    render(<Harness />)
    expect(screen.getByTestId('v')).toBeInTheDocument()
  })
})

describe('onVisibleRangeChange', () => {
  /** Captures the live getter, so a test can read it after a scroll that provoked no render. */
  const captured: { read?: () => readonly [number, number] } = {}

  const Harness = ({
    onVisibleRangeChange,
  }: {
    onVisibleRangeChange?: (r: readonly [number, number]) => void
  }) => {
    const list = useVirtualList({
      items: comments(500),
      getItemKey: (c) => c.id,
      estimateSize: () => 100,
      ...(onVisibleRangeChange === undefined ? {} : { onVisibleRangeChange }),
    })
    captured.read = list.getVisibleRange
    return (
      <div ref={list.scrollRef} data-testid="scroller">
        <div ref={list.containerRef}>
          {list.items.map((rendered) => (
            <div key={rendered.key} ref={list.itemRef(rendered.key)} />
          ))}
        </div>
        {/* The value as React last saw it, for contrast with the live getter. */}
        <span data-testid="rendered">{list.getVisibleRange().join(',')}</span>
      </div>
    )
  }

  /** jsdom keeps an assigned `scrollTop` given the stubbed metrics, and publishes are sync. */
  const scrollTo = (top: number) => {
    const scroller = screen.getByTestId('scroller')
    act(() => {
      scroller.scrollTop = top
      scroller.dispatchEvent(new Event('scroll'))
    })
  }

  it('reports the first range once the engine mounts', () => {
    const seen: (readonly [number, number])[] = []
    render(<Harness onVisibleRangeChange={(range) => { seen.push(range) }} />)

    // Seeded from the empty sentinel, so the first real range arrives as a notification rather
    // than being silently adopted.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)?.[1]).toBeGreaterThan(0)
  })

  it('fires for a scroll that provokes no render at all', () => {
    // The whole reason this is a callback: `needsRerender` omits `visibleRange`, so a scroll
    // within the mounted set is invisible to React. An effect on a render snapshot would miss
    // exactly this.
    const seen: (readonly [number, number])[] = []
    render(<Harness onVisibleRangeChange={(range) => { seen.push(range) }} />)
    const count = seen.length

    scrollTo(220)

    expect(seen.length).toBeGreaterThan(count)
    expect(seen.at(-1)?.[0]).toBeGreaterThan(0)
  })

  it('stays quiet when the range does not move', () => {
    const seen: (readonly [number, number])[] = []
    render(<Harness onVisibleRangeChange={(range) => { seen.push(range) }} />)

    scrollTo(220)
    const settled = seen.length
    // A sub-item nudge: a fresh tuple is published, with the same two numbers in it.
    scrollTo(221)

    expect(seen.length).toBe(settled)
  })

  it('does not re-fire when only the callback identity changes', () => {
    const seen: string[] = []
    const { rerender } = render(
      <Harness onVisibleRangeChange={(range) => { seen.push(`a:${range.join(',')}`) }} />,
    )
    scrollTo(220)
    const before = seen.length

    rerender(<Harness onVisibleRangeChange={(range) => { seen.push(`b:${range.join(',')}`) }} />)

    // Resubscribing reseeds from the current state, so swapping callbacks reports nothing.
    expect(seen.length).toBe(before)
  })

  it('reads live through getVisibleRange, which the render snapshot cannot', () => {
    render(<Harness />)
    const rendered = screen.getByTestId('rendered').textContent

    scrollTo(3000)

    // The scroll stayed inside the mounted set, so React never re-rendered and the text is
    // exactly what it was. The getter went to the store instead.
    expect(screen.getByTestId('rendered').textContent).toBe(rendered)
    expect(captured.read?.()[0]).toBeGreaterThan(0)
    expect(captured.read?.().join(',')).not.toBe(rendered)
  })
})
