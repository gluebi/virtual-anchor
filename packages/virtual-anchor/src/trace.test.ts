import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEBUG } from './debugFlag.js'
import { emitTrace } from './trace.test.helpers.js'
import {
  addTraceListener,
  isTracing,
  setTraceSink,
  trace,
  type TraceEvent,
} from './trace.js'

/** Whatever a test added, gone before the next one. */
const added: (() => void)[] = []
const listen = (sink: (event: TraceEvent) => void): void => {
  added.push(addTraceListener(sink))
}

afterEach(() => {
  setTraceSink(null)
  for (const remove of added) remove()
  added.length = 0
})

describe('trace', () => {
  it('is available in a non-production build', () => {
    // The flag reaches this suite through its `NODE_ENV` fallback, not through a `define`:
    // vitest sets `NODE_ENV=test`, and nothing defines the identifier. That is deliberate,
    // because it means the tests exercise the arm any consumer of the *source* gets.
    expect(DEBUG).toBe(true)
  })

  it('does nothing at all until a sink is installed', () => {
    // The payload thunk is the whole point: with no sink, tracing must not cost even the
    // construction of the object it would have reported.
    const payload = vi.fn(() => ({ offset: 1, carry: 0, shift: 0 }))
    expect(isTracing()).toBe(false)
    trace('scroll.sample', payload)
    expect(payload).not.toHaveBeenCalled()
  })

  it('reports topic, payload and a timestamp to the sink', () => {
    const events: TraceEvent[] = []
    expect(setTraceSink((event) => events.push(event))).toBe(true)
    expect(isTracing()).toBe(true)

    emitTrace('scroll.finish', { settled: true })

    expect(events).toHaveLength(1)
    expect(events[0]?.topic).toBe('scroll.finish')
    expect(events[0]?.data).toEqual({ settled: true })
    expect(typeof events[0]?.at).toBe('number')
  })

  it('stops reporting once the sink is removed', () => {
    const sink = vi.fn()
    setTraceSink(sink)
    emitTrace('scroll.sample')
    setTraceSink(null)
    emitTrace('scroll.gate')
    expect(sink).toHaveBeenCalledTimes(1)
  })
})

describe('more than one listener', () => {
  it('delivers to every listener, in the order they were added', () => {
    const order: string[] = []
    listen(() => order.push('first'))
    listen(() => order.push('second'))

    emitTrace('scroll.step')

    expect(order).toEqual(['first', 'second'])
  })

  it('hands every listener the same event object', () => {
    // Load-bearing rather than incidental: the payload thunk runs once, so `TraceEvent`'s
    // `readonly` typing is what stops one listener corrupting the next.
    const seen: TraceEvent[] = []
    listen((event) => seen.push(event))
    listen((event) => seen.push(event))

    emitTrace('scroll.write', { delta: 1 })

    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
  })

  it('builds the payload once, however many listeners there are', () => {
    const payload = vi.fn(() => ({ offset: 1, carry: 0, shift: 0 }))
    listen(() => {})
    listen(() => {})

    trace('scroll.sample', payload)

    expect(payload).toHaveBeenCalledTimes(1)
  })

  it('removes only the listener whose unsubscribe was called', () => {
    const kept = vi.fn()
    const dropped = vi.fn()
    listen(kept)
    const stop = addTraceListener(dropped)

    stop()
    emitTrace('scroll.sample')

    expect(kept).toHaveBeenCalledTimes(1)
    expect(dropped).not.toHaveBeenCalled()
  })

  it('tolerates a listener removing itself mid-dispatch', () => {
    const later = vi.fn()
    const stop = addTraceListener(() => {
      stop()
    })
    added.push(stop)
    listen(later)

    emitTrace('scroll.sample')
    emitTrace('scroll.gate')

    // The self-removal must not cost the listener behind it either event.
    expect(later).toHaveBeenCalledTimes(2)
  })

  it('keeps a throwing listener from silencing the ones before it', () => {
    // Deliberately not caught — see `addTraceListener`. What is asserted here is the half
    // that must hold: a throw cannot un-deliver an event already delivered.
    const first = vi.fn()
    listen(first)
    listen(() => {
      throw new Error('listener blew up')
    })

    expect(() => {
      emitTrace('scroll.sample')
    }).toThrow('listener blew up')
    expect(first).toHaveBeenCalledTimes(1)
  })

  it('does not let setTraceSink evict a listener it did not install', () => {
    // The whole reason `addTraceListener` exists: the demo installed a ring buffer and then
    // replaced it with a HUD, silently losing the first.
    const listener = vi.fn()
    const sink = vi.fn()
    listen(listener)
    setTraceSink(sink)

    emitTrace('scroll.sample')
    setTraceSink(null)
    emitTrace('scroll.gate')

    expect(sink).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('reports whether anything is listening at all', () => {
    expect(isTracing()).toBe(false)
    const stop = addTraceListener(() => {})
    expect(isTracing()).toBe(true)
    stop()
    expect(isTracing()).toBe(false)
  })
})
