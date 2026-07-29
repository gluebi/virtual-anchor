import { describe, expect, it } from 'vitest'
import { createVirtualStore, EMPTY_STATE, needsRerender, type VirtualState } from './store.js'

const state = (overrides: Partial<VirtualState> = {}): VirtualState => ({
  ...EMPTY_STATE,
  ...overrides,
})

const items = (from: number, to: number, prefix = 'c') =>
  Array.from({ length: to - from + 1 }, (_, offset) => {
    const index = from + offset
    return {
      key: `${prefix}${String(index)}`,
      index,
      start: index * 100,
      size: 100,
      measured: true,
    }
  })

describe('createVirtualStore', () => {
  it('starts empty and notifies subscribers', () => {
    const store = createVirtualStore()
    expect(store.getState()).toBe(EMPTY_STATE)

    const seen: number[] = []
    const off = store.subscribe((next) => seen.push(next.version))
    store.setState({ ...EMPTY_STATE, version: 1 })
    store.setState({ ...EMPTY_STATE, version: 2 })
    off()
    store.setState({ ...EMPTY_STATE, version: 3 })

    expect(seen).toEqual([1, 2])
  })
})

describe('needsRerender', () => {
  it('says no when only the scroll offset moved', () => {
    // The whole point: positions are written straight to the DOM, so a scroll that
    // moves items within an unchanged mounted set needs no React work at all. This
    // predicate is what turns most scroll frames into zero renders.
    const previous = state({ items: items(0, 5), renderedRange: [0, 5], scrollOffset: 0 })
    const next = state({ ...previous, version: 2, scrollOffset: 500 })
    expect(needsRerender(previous, next)).toBe(false)
  })

  it('says no when only item offsets changed within the same key set', () => {
    const previous = state({ items: items(0, 5), renderedRange: [0, 5], totalSize: 600 })
    const moved = previous.items.map((item) => ({ ...item, start: item.start + 40 }))
    const next = state({ ...previous, version: 2, items: moved })
    expect(needsRerender(previous, next)).toBe(false)
  })

  it('says yes when the rendered range moves', () => {
    const previous = state({ items: items(0, 5), renderedRange: [0, 5] })
    expect(
      needsRerender(previous, state({ ...previous, renderedRange: [1, 5] })),
    ).toBe(true)
    expect(
      needsRerender(previous, state({ ...previous, renderedRange: [0, 6] })),
    ).toBe(true)
  })

  it('says yes when the total size changes, since the sizer must grow', () => {
    const previous = state({ items: items(0, 5), renderedRange: [0, 5], totalSize: 600 })
    expect(needsRerender(previous, state({ ...previous, totalSize: 900 }))).toBe(true)
  })

  it('says yes when a programmatic scroll starts or stops', () => {
    const previous = state({ items: items(0, 5), renderedRange: [0, 5] })
    expect(needsRerender(previous, state({ ...previous, scrolling: true }))).toBe(true)
  })

  it('says yes when the same range holds different keys', () => {
    // A prepend keeps the index range identical while every key in it changes, so
    // comparing ranges alone would render the wrong comments.
    const previous = state({ items: items(0, 5), renderedRange: [0, 5] })
    const next = state({ ...previous, items: items(0, 5, 'other') })
    expect(needsRerender(previous, next)).toBe(true)
  })

  it('says yes when the item count changes', () => {
    const previous = state({ items: items(0, 5), renderedRange: [0, 5] })
    const next = state({ ...previous, items: items(0, 6), renderedRange: [0, 5] })
    expect(needsRerender(previous, next)).toBe(true)
  })

  it('says no for an identical state', () => {
    const previous = state({ items: items(0, 5), renderedRange: [0, 5] })
    expect(needsRerender(previous, { ...previous, version: 99 })).toBe(false)
  })

  it('says no between two empty states', () => {
    expect(needsRerender(EMPTY_STATE, EMPTY_STATE)).toBe(false)
  })
})
