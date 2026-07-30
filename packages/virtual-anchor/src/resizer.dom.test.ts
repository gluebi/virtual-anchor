import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createResizer, type ResizeBatch, type SlotResizeBatch } from './resizer.js'

/**
 * A controllable stand-in for ResizeObserver.
 *
 * jsdom does not implement ResizeObserver, and even in a real browser the
 * delivery timing is not something a unit test should be at the mercy of. This
 * lets each test deliver an exact batch and assert what came out the other side.
 */
class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = []

  readonly observed = new Set<Element>()
  disconnected = false

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.observed.add(target)
  }

  unobserve(target: Element): void {
    this.observed.delete(target)
  }

  disconnect(): void {
    this.disconnected = true
    this.observed.clear()
  }

  /** Deliver a batch of block-axis sizes as one callback, as the real API does. */
  deliver(sizes: readonly (readonly [Element, number])[]): void {
    const entries = sizes.map(([target, blockSize]) => ({
      target,
      borderBoxSize: [{ blockSize, inlineSize: 0 }],
      contentBoxSize: [{ blockSize, inlineSize: 0 }],
      devicePixelContentBoxSize: [{ blockSize, inlineSize: 0 }],
      contentRect: new DOMRect(0, 0, 0, blockSize),
    })) as unknown as ResizeObserverEntry[]
    this.callback(entries, this)
  }

  static latest(): FakeResizeObserver {
    const instance = FakeResizeObserver.instances.at(-1)
    if (!instance) throw new Error('no ResizeObserver was constructed')
    return instance
  }
}

const originalRO = globalThis.ResizeObserver

beforeEach(() => {
  FakeResizeObserver.instances = []
  globalThis.ResizeObserver = FakeResizeObserver
  // The resizer constructs from the element's own window, not the global.
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: FakeResizeObserver,
  })
  document.body.replaceChildren()
})

afterEach(() => {
  globalThis.ResizeObserver = originalRO
  vi.restoreAllMocks()
})

const addItem = (): HTMLElement => {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

describe('createResizer', () => {
  it('delivers one batch per observer callback, not one per entry', () => {
    const onItemResize = vi.fn<(batch: ResizeBatch) => void>()
    const resizer = createResizer({ onItemResize })
    const a = addItem()
    const b = addItem()
    resizer.observeItem(a, 'a')
    resizer.observeItem(b, 'b')

    FakeResizeObserver.latest().deliver([
      [a, 100],
      [b, 250],
    ])

    expect(onItemResize).toHaveBeenCalledTimes(1)
    expect(onItemResize.mock.calls[0]?.[0]).toEqual([
      ['a', 100],
      ['b', 250],
    ])
  })

  it('rejects zero sizes, which mean invisible rather than empty', () => {
    // A hidden tab, `display: none`, a closed <details> or a suspended subtree
    // all measure 0. A single zero in the prefix sum collapses the geometry and
    // makes a scroll target move every frame — a hang, not a glitch.
    const onItemResize = vi.fn()
    const resizer = createResizer({ onItemResize })
    const item = addItem()
    resizer.observeItem(item, 'a')

    FakeResizeObserver.latest().deliver([[item, 0]])
    expect(onItemResize).not.toHaveBeenCalled()

    FakeResizeObserver.latest().deliver([[item, -5]])
    expect(onItemResize).not.toHaveBeenCalled()

    FakeResizeObserver.latest().deliver([[item, Number.NaN]])
    expect(onItemResize).not.toHaveBeenCalled()
  })

  it('ignores detached elements', () => {
    const onItemResize = vi.fn()
    const resizer = createResizer({ onItemResize })
    const item = addItem()
    resizer.observeItem(item, 'a')

    item.remove()
    FakeResizeObserver.latest().deliver([[item, 300]])
    expect(onItemResize).not.toHaveBeenCalled()
  })

  it('ignores elements it was never given a key for', () => {
    const onItemResize = vi.fn()
    createResizer({ onItemResize })
    const stranger = addItem()

    // Construct the observer by observing something legitimate first.
    const resizer = createResizer({ onItemResize })
    resizer.observeItem(addItem(), 'a')
    FakeResizeObserver.latest().deliver([[stranger, 300]])

    expect(onItemResize).not.toHaveBeenCalled()
  })

  it('deduplicates by value, dropping the synthetic first entry', () => {
    // observe() always delivers an entry for a newly observed element, which
    // repeats whatever the initial synchronous measurement already recorded.
    const onItemResize = vi.fn()
    const resizer = createResizer({ onItemResize })
    const item = addItem()
    resizer.observeItem(item, 'a')

    FakeResizeObserver.latest().deliver([[item, 300]])
    FakeResizeObserver.latest().deliver([[item, 300]])
    FakeResizeObserver.latest().deliver([[item, 301]])

    expect(onItemResize).toHaveBeenCalledTimes(2)
    expect(onItemResize.mock.calls[1]?.[0]).toEqual([['a', 301]])
  })

  it('survives a StrictMode-style double mount without double-reporting', () => {
    const onItemResize = vi.fn()
    const resizer = createResizer({ onItemResize })
    const item = addItem()

    const cleanup = resizer.observeItem(item, 'a')
    FakeResizeObserver.latest().deliver([[item, 300]])
    cleanup()

    // React mounts again with the same element and key.
    resizer.observeItem(item, 'a')
    FakeResizeObserver.latest().deliver([[item, 300]])

    // Re-observing legitimately re-reports, because the cleanup forgot the
    // cached size — but the value is identical, so nothing downstream changes.
    expect(onItemResize).toHaveBeenCalledTimes(2)
    expect(onItemResize.mock.calls.every((call) => call[0]?.[0]?.[1] === 300)).toBe(true)
  })

  it('stops reporting an item once its cleanup runs', () => {
    const onItemResize = vi.fn()
    const resizer = createResizer({ onItemResize })
    const item = addItem()

    const cleanup = resizer.observeItem(item, 'a')
    cleanup()
    FakeResizeObserver.latest().deliver([[item, 300]])

    expect(onItemResize).not.toHaveBeenCalled()
    expect(FakeResizeObserver.latest().observed.has(item)).toBe(false)
  })

  it('observes the border box, so padding and borders are included', () => {
    const resizer = createResizer({ onItemResize: vi.fn() })
    const item = addItem()
    const observeSpy = vi.spyOn(FakeResizeObserver.prototype, 'observe')
    resizer.observeItem(item, 'a')

    expect(observeSpy).toHaveBeenCalledWith(item, { box: 'border-box' })
  })

  it('falls back to a client rect when borderBoxSize is unavailable', () => {
    const onItemResize = vi.fn()
    const resizer = createResizer({ onItemResize })
    const item = addItem()
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 0, 175))
    resizer.observeItem(item, 'a')

    const observer = FakeResizeObserver.latest()
    const entries = [{ target: item, borderBoxSize: [] }] as unknown as ResizeObserverEntry[]
    // Reach the private callback the same way the platform would.
    ;(observer as unknown as { callback: ResizeObserverCallback }).callback(entries, observer)

    expect(onItemResize).toHaveBeenCalledExactlyOnceWith([['a', 175]])
  })

  it('defers to an animation frame only when asked', () => {
    const onItemResize = vi.fn()
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb)
      return frames.length
    })

    const resizer = createResizer({ onItemResize, useAnimationFrame: true })
    const item = addItem()
    resizer.observeItem(item, 'a')

    FakeResizeObserver.latest().deliver([[item, 300]])
    expect(onItemResize).not.toHaveBeenCalled()

    frames.forEach((frame) => {
      frame(0)
    })
    expect(onItemResize).toHaveBeenCalledExactlyOnceWith([['a', 300]])
  })

  it('measures synchronously for a freshly mounted item', () => {
    // ResizeObserver's first callback arrives after the next rendering update,
    // so a newly mounted destination row has to be read directly or the frame
    // paints at the wrong offset.
    const resizer = createResizer({ onItemResize: vi.fn() })
    const item = addItem()
    vi.spyOn(item, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 0, 412))

    expect(resizer.measure(item)).toBe(412)
  })

  it('reports nothing after disposal', () => {
    const onItemResize = vi.fn()
    const resizer = createResizer({ onItemResize })
    const item = addItem()
    resizer.observeItem(item, 'a')
    const observer = FakeResizeObserver.latest()

    resizer.dispose()
    expect(observer.disconnected).toBe(true)

    observer.deliver([[item, 300]])
    expect(onItemResize).not.toHaveBeenCalled()
    // Observing after disposal is inert and its detach is safe to call.
    const detachItem = resizer.observeItem(addItem(), 'b')
    expect(() => {
      detachItem()
    }).not.toThrow()
  })
})

describe('createResizer margin warnings', () => {
  it('names the offending item when it carries a block margin', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const resizer = createResizer({ onItemResize: vi.fn() })
    const item = addItem()
    item.style.marginTop = '12px'

    resizer.observeItem(item, 'comment-42')

    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('comment-42')
    expect(warn.mock.calls[0]?.[0]).toContain('marginTop')
    expect(warn.mock.calls[0]?.[0]).toContain('`gap`')
  })

  it('catches a bottom margin too', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const resizer = createResizer({ onItemResize: vi.fn() })
    const item = addItem()
    item.style.marginBottom = '8px'

    resizer.observeItem(item, 'comment-7')
    expect(warn.mock.calls[0]?.[0]).toContain('marginBottom')
  })

  it('stays quiet for well-behaved items', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const resizer = createResizer({ onItemResize: vi.fn() })
    resizer.observeItem(addItem(), 'a')

    expect(warn).not.toHaveBeenCalled()
  })

  it('checks only the first few items, not every one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const resizer = createResizer({ onItemResize: vi.fn() })

    for (let i = 0; i < 20; i++) {
      const item = addItem()
      item.style.marginTop = '4px'
      resizer.observeItem(item, `comment-${String(i)}`)
    }

    expect(warn.mock.calls.length).toBeLessThanOrEqual(5)
    expect(warn).toHaveBeenCalled()
  })

  it('can be switched off', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const resizer = createResizer({ onItemResize: vi.fn(), checkMargins: false })
    const item = addItem()
    item.style.marginTop = '12px'

    resizer.observeItem(item, 'a')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('createResizer slots', () => {
  /** jsdom lays nothing out, so a slot has to be told it has a box. */
  const addSlot = (laidOut = true): HTMLElement => {
    const el = addItem()
    vi.spyOn(el, 'getClientRects').mockReturnValue(
      (laidOut ? [new DOMRect(0, 0, 600, 0)] : []) as unknown as DOMRectList,
    )
    return el
  }

  it('reports slot sizes on their own channel, in one batch', () => {
    const onSlotResize = vi.fn<(batch: SlotResizeBatch) => void>()
    const resizer = createResizer({ onItemResize: vi.fn(), onSlotResize })

    const header = addSlot()
    const footer = addSlot()
    resizer.observeSlot(header, 'header')
    resizer.observeSlot(footer, 'footer')

    FakeResizeObserver.latest().deliver([
      [header, 300],
      [footer, 120],
    ])

    expect(onSlotResize).toHaveBeenCalledTimes(1)
    expect(onSlotResize.mock.calls[0]?.[0]).toEqual([
      ['header', 300],
      ['footer', 120],
    ])
  })

  it('keeps slots and items apart in a mixed callback', () => {
    // Slots first, deliberately: a header that grew in the same frame as an item
    // measured moves the list's origin, and applying that before the sizes means
    // the anchor is restored once against final geometry rather than twice.
    const order: string[] = []
    const resizer = createResizer({
      onItemResize: () => order.push('items'),
      onSlotResize: () => order.push('slots'),
    })

    const item = addItem()
    const header = addSlot()
    resizer.observeItem(item, 'a')
    resizer.observeSlot(header, 'header')

    FakeResizeObserver.latest().deliver([
      [item, 90],
      [header, 300],
    ])

    expect(order).toEqual(['slots', 'items'])
  })

  it('reports a slot that measures zero, unlike an item', () => {
    // An empty footer is a real height. Refusing it — as the item channel must,
    // because a zero slot collapses the prefix sum — would leave the space it used
    // to occupy behind forever, which is react-virtuoso #1203.
    const onSlotResize = vi.fn<(batch: SlotResizeBatch) => void>()
    const resizer = createResizer({ onItemResize: vi.fn(), onSlotResize })

    const footer = addSlot()
    resizer.observeSlot(footer, 'footer')
    FakeResizeObserver.latest().deliver([[footer, 200]])
    FakeResizeObserver.latest().deliver([[footer, 0]])

    expect(onSlotResize).toHaveBeenCalledTimes(2)
    expect(onSlotResize.mock.calls[1]?.[0]).toEqual([['footer', 0]])
  })

  it('refuses a zero from an element with no box at all', () => {
    // `display: none`, a hidden tab, a collapsed `<details>`. Reading that as "the
    // header went away" would restore the anchor against a scroller that cannot
    // scroll, the write would clamp to zero, and the position would be lost for real.
    const onSlotResize = vi.fn<(batch: SlotResizeBatch) => void>()
    const resizer = createResizer({ onItemResize: vi.fn(), onSlotResize })

    const header = addSlot(false)
    resizer.observeSlot(header, 'header')
    FakeResizeObserver.latest().deliver([[header, 0]])

    expect(onSlotResize).not.toHaveBeenCalled()
  })

  it('ignores a detached slot', () => {
    const onSlotResize = vi.fn<(batch: SlotResizeBatch) => void>()
    const resizer = createResizer({ onItemResize: vi.fn(), onSlotResize })

    const header = addSlot()
    resizer.observeSlot(header, 'header')
    header.remove()
    FakeResizeObserver.latest().deliver([[header, 300]])

    expect(onSlotResize).not.toHaveBeenCalled()
  })

  it('reports a remount at the height it had before', () => {
    // The dedup cache is keyed by slot, not by element, so dropping the entry on
    // detach is what stops a header remounting at its old height from being read as
    // "unchanged" — and therefore silently never restored.
    const onSlotResize = vi.fn<(batch: SlotResizeBatch) => void>()
    const resizer = createResizer({ onItemResize: vi.fn(), onSlotResize })

    const first = addSlot()
    const stop = resizer.observeSlot(first, 'header')
    FakeResizeObserver.latest().deliver([[first, 300]])
    stop()

    const second = addSlot()
    resizer.observeSlot(second, 'header')
    FakeResizeObserver.latest().deliver([[second, 300]])

    expect(onSlotResize).toHaveBeenCalledTimes(2)
    expect(onSlotResize.mock.calls[1]?.[0]).toEqual([['header', 300]])
  })

  it('warns about a margin on a slot, naming which one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const resizer = createResizer({ onItemResize: vi.fn() })

    const header = addSlot()
    header.style.marginBottom = '16px'
    resizer.observeSlot(header, 'header')

    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('the header slot')
  })

  it('does nothing once disposed', () => {
    const onSlotResize = vi.fn<(batch: SlotResizeBatch) => void>()
    const resizer = createResizer({ onItemResize: vi.fn(), onSlotResize })
    resizer.dispose()

    expect(() => {
      resizer.observeSlot(addSlot(), 'header')()
    }).not.toThrow()
    expect(onSlotResize).not.toHaveBeenCalled()
  })
})
