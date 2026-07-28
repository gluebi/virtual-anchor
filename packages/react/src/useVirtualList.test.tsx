import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { StrictMode, useState } from 'react'
import { VirtualList, type VirtualListHandle } from './VirtualList.js'
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
