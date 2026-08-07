import { describe, expect, it } from 'vitest'
import type { GestureVerdict } from './analyzer.js'
import { formatLive, formatVerdict } from './format.js'

/**
 * The wording, under test.
 *
 * Separated from the overlay because this is the part a reader squinting at a 390px screen
 * actually depends on, and a pure string function can be asserted exactly. The overlay's job is
 * then only to put this text somewhere.
 */

const verdict = (over: Partial<GestureVerdict> = {}): GestureVerdict => ({
  index: 0,
  startedAt: 0,
  endedAt: 900,
  durationMs: 900,
  liftedAt: 200,
  flingMs: 700,
  liftVelocity: -2.4,
  gate: 'ios',
  states: [],
  scrolls: 40,
  worstScrollGapMs: 18,
  frozenMs: 0,
  travelPx: 1400,
  writes: { taken: 0, held: 2, byReason: { 'gate-open': 0, held: 2, 'no-room': 0, model: 0 } },
  escapes: [],
  heldPeak: 23,
  fold: null,
  scrollerWrites: 0,
  parks: 0,
  wakes: 0,
  measure: { batches: 0, totalMs: 0, worstMs: 0, invalidations: 0 },
  longestFrameMs: 0,
  probeRunning: false,
  ended: 'settled',
  truncated: false,
  suspects: [],
  ...over,
})

describe('the live strip', () => {
  it('says what it is waiting for before anything has happened', () => {
    expect(formatLive(null)).toContain('waiting for a gesture')
  })

  it('leads with the gate word, which answers the platform question at a glance', () => {
    expect(formatLive(verdict())).toMatch(/^gate ios/)
  })

  it('fits on one line, because it repaints while a finger is on the glass', () => {
    expect(formatLive(verdict())).not.toContain('\n')
  })
})

describe('the verdict pane', () => {
  it('says so when there is nothing yet', () => {
    expect(formatVerdict(null)).toBe('no gesture recorded yet')
  })

  it('names the outcome and the fling duration', () => {
    const text = formatVerdict(verdict())
    expect(text).toContain('ended: settled')
    expect(text).toContain('fling 700ms')
  })

  it('says plainly when nothing was found', () => {
    expect(formatVerdict(verdict())).toContain('no suspect found')
  })

  it('omits the reason breakdown when every count is zero', () => {
    // A row of zeros reads as reassurance and costs the space the suspects need.
    expect(formatVerdict(verdict({ writes: { taken: 0, held: 0, byReason: { 'gate-open': 0, held: 0, 'no-room': 0, model: 0 } } }))).not.toContain('by reason')
  })

  it('shows the reason breakdown when something is non-zero', () => {
    expect(formatVerdict(verdict())).toContain('by reason: held=2')
  })

  it('marks a confirmed suspect more loudly than a suspected one', () => {
    const confirmed = formatVerdict(
      verdict({ suspects: [{ id: 'no-room-at-end', confidence: 'confirmed', evidence: 'x', at: 1 }] }),
    )
    const suspected = formatVerdict(
      verdict({ suspects: [{ id: 'no-room-at-end', confidence: 'suspected', evidence: 'x', at: 1 }] }),
    )
    expect(confirmed).toContain('!! no-room-at-end')
    expect(suspected).toContain(' ? no-room-at-end')
  })

  it('wraps evidence by hand, so the box height stays predictable', () => {
    const long =
      'a very long explanation that would otherwise wrap wherever the browser felt like ' +
      'wrapping it and push the last suspect off the bottom of a fixed-height box'
    const lines = formatVerdict(
      verdict({ suspects: [{ id: 'starvation', confidence: 'confirmed', evidence: long, at: 1 }] }),
    ).split('\n')
    expect(lines.every((line) => line.length <= 48)).toBe(true)
    // And nothing is lost to the wrapping. Re-joined with the indentation collapsed, since the
    // wrap is what inserted both the breaks and the leading spaces.
    expect(lines.join(' ').replace(/\s+/g, ' ')).toContain('push the last suspect off the bottom')
  })

  it('reports a clean fold as clean and a clamped one loudly', () => {
    expect(formatVerdict(verdict({ fold: { at: 1, shift: 23, clamped: false, discontinuity: 0.25 } })))
      .toContain('fold 23px clean')
    expect(formatVerdict(verdict({ fold: { at: 1, shift: 400, clamped: true, discontinuity: 380 } })))
      .toContain('CLAMPED')
  })

  it('refuses to rank a truncated record, and says why instead', () => {
    const text = formatVerdict(
      verdict({
        truncated: true,
        suspects: [{ id: 'cap', confidence: 'confirmed', evidence: 'x', at: 1 }],
      }),
    )
    expect(text).toContain('RECORD TRUNCATED')
    // The suspect must not appear: a verdict from a partial record reads as a false all-clear,
    // and one drawn from it is worse than none. Matched on the marker rather than the bare id,
    // because the truncation notice itself mentions raising the ring's *cap*acity.
    expect(text).not.toContain('!! cap')
    expect(text).not.toContain(' ? cap')
  })

  it('warns that the frame probe perturbs the timing it reports', () => {
    expect(formatVerdict(verdict({ probeRunning: true }))).toContain('perturbs timing')
  })
})
