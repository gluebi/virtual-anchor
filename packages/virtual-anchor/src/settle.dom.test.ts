import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onScrollSettled } from './settle.js'
import type { Viewport } from './viewport.js'

/**
 * Settle detection, both paths.
 *
 * The debounce fallback matters more than it looks: it is what bounds a momentum
 * fling on any Safari without `scrollend`, and it suits that job better than the one
 * it was written for — momentum emits a continuous stream of scroll events, so the
 * debounce cannot expire until the fling has actually stopped.
 */
const harness = (): {
  viewport: Viewport
  emit: (type: string) => void
  listenerCount: (type: string) => number
} => {
  const listeners = new Map<string, Set<() => void>>()

  const viewport = {
    addEventListener: (type: string, listener: () => void) => {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    },
  } as unknown as Viewport

  return {
    viewport,
    emit: (type) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener()
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('onScrollSettled', () => {
  describe('where scrollend is available', () => {
    it('reports on the native event', () => {
      const h = harness()
      const settled = vi.fn()
      onScrollSettled(h.viewport, settled)

      h.emit('scrollend')
      expect(settled).toHaveBeenCalledTimes(1)
    })

    it('does not subscribe to scroll at all', () => {
      const h = harness()
      onScrollSettled(h.viewport, vi.fn())
      expect(h.listenerCount('scroll')).toBe(0)
    })

    it('unsubscribes', () => {
      const h = harness()
      const settled = vi.fn()
      onScrollSettled(h.viewport, settled)()

      h.emit('scrollend')
      expect(settled).not.toHaveBeenCalled()
    })
  })

  describe('where scrollend is missing', () => {
    let descriptor: PropertyDescriptor | undefined

    beforeEach(() => {
      descriptor = Object.getOwnPropertyDescriptor(window, 'onscrollend')
      Reflect.deleteProperty(window, 'onscrollend')
    })

    afterEach(() => {
      if (descriptor) Object.defineProperty(window, 'onscrollend', descriptor)
    })

    it('debounces scroll instead', () => {
      const h = harness()
      const settled = vi.fn()
      onScrollSettled(h.viewport, settled)

      h.emit('scroll')
      vi.advanceTimersByTime(149)
      expect(settled).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(settled).toHaveBeenCalledTimes(1)
    })

    it('does not report while the scrolling continues', () => {
      // The momentum case: a fling emits a scroll event every frame, so the timer is
      // restarted before it can expire and the gate stays correctly shut.
      const h = harness()
      const settled = vi.fn()
      onScrollSettled(h.viewport, settled)

      for (let i = 0; i < 20; i++) {
        h.emit('scroll')
        vi.advanceTimersByTime(16)
      }
      expect(settled).not.toHaveBeenCalled()

      vi.advanceTimersByTime(150)
      expect(settled).toHaveBeenCalledTimes(1)
    })

    it('cancels a pending timer when unsubscribed', () => {
      const h = harness()
      const settled = vi.fn()
      const off = onScrollSettled(h.viewport, settled)

      h.emit('scroll')
      off()
      vi.advanceTimersByTime(500)

      expect(settled).not.toHaveBeenCalled()
      expect(h.listenerCount('scroll')).toBe(0)
    })

    it('unsubscribes cleanly with no timer pending', () => {
      const h = harness()
      onScrollSettled(h.viewport, vi.fn())()
      expect(h.listenerCount('scroll')).toBe(0)
    })
  })
})
