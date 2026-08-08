import { afterEach, describe, expect, it, vi } from 'vitest'
import { emitTrace } from '../trace.test.helpers.js'
import { setTraceSink } from '../trace.js'
import { createTraceRecorder, type TraceRecorder } from './recorder.js'

const open: TraceRecorder[] = []
const recorder = (...args: Parameters<typeof createTraceRecorder>): TraceRecorder => {
  const made = createTraceRecorder(...args)
  open.push(made)
  return made
}

afterEach(() => {
  for (const made of open) made.dispose()
  open.length = 0
  setTraceSink(null)
})

describe('the ring', () => {
  it('records what the library traced', () => {
    const held = recorder()
    emitTrace('scroll.write', { delta: 4 })
    emitTrace('scroll.sample', { offset: 10 })

    expect(held.size()).toBe(2)
    expect(held.select().map((event) => event.topic)).toEqual(['scroll.write', 'scroll.sample'])
  })

  it('keeps the newest events and counts what it dropped', () => {
    const held = recorder({ capacity: 3 })
    for (let i = 0; i < 5; i++) emitTrace('scroll.sample', { offset: i })

    expect(held.size()).toBe(3)
    expect(held.dropped()).toBe(2)
    // Oldest first, which is the only order the analyzer can read.
    expect(held.select().map((event) => event.data.offset)).toEqual([2, 3, 4])
  })

  it('reports nothing dropped until it is actually full', () => {
    const held = recorder({ capacity: 3 })
    for (let i = 0; i < 3; i++) emitTrace('scroll.sample', { offset: i })
    expect(held.dropped()).toBe(0)
  })

  it('filters on topic prefixes at record time, so the ring reaches further back', () => {
    const held = recorder({ capacity: 10, topics: ['scroll.'] })
    emitTrace('scroll.write')
    emitTrace('anchor.derive')
    emitTrace('scroll.sample')

    expect(held.select().map((event) => event.topic)).toEqual(['scroll.write', 'scroll.sample'])
  })

  it('tees events onward for a live readout', () => {
    const seen = vi.fn()
    recorder({ onEvent: seen })
    emitTrace('scroll.write')
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('does not tee an event it filtered out', () => {
    const seen = vi.fn()
    recorder({ topics: ['gesture.'], onEvent: seen })
    emitTrace('scroll.write')
    expect(seen).not.toHaveBeenCalled()
  })

  it('clears back to empty, dropped count included', () => {
    const held = recorder({ capacity: 2 })
    for (let i = 0; i < 4; i++) emitTrace('scroll.sample', { offset: i })
    held.clear()
    expect(held.size()).toBe(0)
    expect(held.dropped()).toBe(0)
    expect(held.select()).toEqual([])
  })

  it('stops recording once disposed', () => {
    const held = recorder()
    held.dispose()
    emitTrace('scroll.write')
    expect(held.size()).toBe(0)
  })

  it('coexists with a consumer’s own sink', () => {
    // The whole point of the fan-out: installing a recorder must not steal anyone's events.
    const theirs = vi.fn()
    setTraceSink(theirs)
    const held = recorder()
    emitTrace('scroll.write')
    expect(theirs).toHaveBeenCalledTimes(1)
    expect(held.size()).toBe(1)
  })
})

describe('querying', () => {
  const populated = (): TraceRecorder => {
    const held = recorder()
    emitTrace('scroll.write', { offset: 1 })
    emitTrace('anchor.derive', { offset: 2 })
    emitTrace('scroll.sample', { offset: 3 })
    return held
  }

  it('filters by topic', () => {
    expect(populated().select({ topics: ['anchor.'] }).map((e) => e.data.offset)).toEqual([2])
  })

  it('takes the most recent N', () => {
    expect(populated().select({ limit: 2 }).map((e) => e.data.offset)).toEqual([2, 3])
  })

  it('applies every filter in one pass', () => {
    const held = populated()
    const all = held.select()
    const middle = all[1]?.at ?? 0
    // Time, topic and limit together — the combination the single-pass walk has to get right and
    // the chained `.filter()` form got right only by allocating an array per clause.
    expect(
      held.select({ since: middle, topics: ['scroll.', 'anchor.'], limit: 1 }).map((e) => e.data.offset),
    ).toEqual([3])
  })

  it('filters by time, inclusively at both ends', () => {
    const held = populated()
    const all = held.select()
    const middle = all[1]?.at ?? 0
    expect(held.select({ since: middle }).map((e) => e.data.offset)).toEqual([2, 3])
    expect(held.select({ until: middle }).map((e) => e.data.offset)).toEqual([1, 2])
  })
})

describe('the revision counter', () => {
  it('advances once per recorded event', () => {
    const held = recorder()
    expect(held.revision()).toBe(0)
    emitTrace('scroll.sample')
    emitTrace('scroll.sample')
    expect(held.revision()).toBe(2)
  })

  it('does not advance for an event the filter dropped', () => {
    const held = recorder({ topics: ['gesture.'] })
    emitTrace('scroll.sample')
    expect(held.revision()).toBe(0)
  })

  it('advances on clear, because clearing is a change a reader must see', () => {
    // Reset to zero instead and a reader gating on it could find the value it last analysed.
    const held = recorder()
    emitTrace('scroll.sample')
    const before = held.revision()
    held.clear()
    expect(held.revision()).toBeGreaterThan(before)
  })
})

describe('the exported report', () => {
  it('round-trips as JSON and carries the environment', () => {
    const held = recorder({ capacity: 2 })
    for (let i = 0; i < 3; i++) emitTrace('scroll.sample', { offset: i })

    const parsed = JSON.parse(held.toJSON()) as {
      meta: { capacity: number; held: number; dropped: number; ua: string | null }
      events: { topic: string }[]
    }

    // `dropped` travels with the report because a reader holding a different device has no other
    // way to know the record is incomplete.
    expect(parsed.meta).toMatchObject({ capacity: 2, held: 2, dropped: 1 })
    expect(parsed.events).toHaveLength(2)
    expect(parsed.events[0]?.topic).toBe('scroll.sample')
  })

  it('honours a query, so the last gesture can be exported alone', () => {
    const held = recorder()
    emitTrace('scroll.write')
    emitTrace('anchor.derive')
    const parsed = JSON.parse(held.toJSON({ topics: ['scroll.'] })) as { events: unknown[] }
    expect(parsed.events).toHaveLength(1)
  })
})
