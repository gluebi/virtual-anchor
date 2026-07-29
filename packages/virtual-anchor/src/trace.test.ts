import { afterEach, describe, expect, it, vi } from 'vitest'
import { isTracing, setTraceSink, TRACING, trace, type TraceEvent } from './trace.js'

afterEach(() => {
  setTraceSink(null)
})

describe('trace', () => {
  it('is available in a non-production build', () => {
    expect(TRACING).toBe(true)
  })

  it('does nothing at all until a sink is installed', () => {
    // The payload thunk is the whole point: with no sink, tracing must not cost even the
    // construction of the object it would have reported.
    const payload = vi.fn(() => ({ a: 1 }))
    expect(isTracing()).toBe(false)
    trace('scroll.step', payload)
    expect(payload).not.toHaveBeenCalled()
  })

  it('reports topic, payload and a timestamp to the sink', () => {
    const events: TraceEvent[] = []
    expect(setTraceSink((event) => events.push(event))).toBe(true)
    expect(isTracing()).toBe(true)

    trace('scroll.finish', () => ({ settled: true }))

    expect(events).toHaveLength(1)
    expect(events[0]?.topic).toBe('scroll.finish')
    expect(events[0]?.data).toEqual({ settled: true })
    expect(typeof events[0]?.at).toBe('number')
  })

  it('stops reporting once the sink is removed', () => {
    const sink = vi.fn()
    setTraceSink(sink)
    trace('a', () => ({}))
    setTraceSink(null)
    trace('b', () => ({}))
    expect(sink).toHaveBeenCalledTimes(1)
  })
})
