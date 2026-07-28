import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode, useState, type ReactNode } from 'react'
import { VirtualList, type VirtualListHandle } from './VirtualList.js'
import type { ItemKey } from 'virtual-anchor'
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
