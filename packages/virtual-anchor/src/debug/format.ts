/**
 * Render a verdict as fixed-width text.
 *
 * Separated from the overlay because the overlay is the *hard* thing to test and this is the
 * easy one: a pure string function can be asserted exactly, so the wording that a reader
 * squinting at a phone depends on is covered without touching the DOM.
 *
 * Written for a 390px screen in a monospace font, which is about 44 characters. Every line
 * either fits or is truncated deliberately — a wrapped line in a `pre` with a fixed height
 * pushes the conclusion off the bottom, and the conclusion is the point.
 */

import type { GestureVerdict } from './analyzer.js'

const px = (n: number): string => `${String(Math.round(n))}px`
const ms = (n: number): string => `${String(Math.round(n))}ms`

/**
 * The one-line live strip, shown while a gesture is in flight.
 *
 * Deliberately not a verdict: mid-fling there is nothing to conclude yet, and a readout that
 * changed its mind every frame would be unreadable at 120 Hz. What it shows is the four
 * numbers that move — and the gate word, which answers "is any of this machinery even running
 * on this platform" at a glance and without an export.
 */
export function formatLive(verdict: GestureVerdict | null): string {
  if (verdict === null) return 'virtual-anchor: waiting for a gesture'
  const { writes, scrolls, heldPeak, worstScrollGapMs, gate } = verdict
  return (
    `gate ${gate}  scrolls ${String(scrolls)}  ` +
    `w ${String(writes.taken)}/${String(writes.held)}  ` +
    `held ${px(heldPeak)}  gap ${ms(worstScrollGapMs)}`
  )
}

/**
 * The post-mortem, updated once per gesture at settle.
 *
 * This is the pane that matters. A live readout during a fling is unreadable — and the finger
 * is on the glass in front of it anyway — so the interesting artefact is what is left
 * afterwards.
 */
export function formatVerdict(verdict: GestureVerdict | null): string {
  if (verdict === null) return 'no gesture recorded yet'

  const lines: string[] = []

  lines.push(
    `#${String(verdict.index)} ${ms(verdict.durationMs)}` +
      (verdict.flingMs === null ? '' : ` (fling ${ms(verdict.flingMs)})`) +
      `  ended: ${verdict.ended}`,
  )
  lines.push(
    `gate ${verdict.gate}  travel ${px(verdict.travelPx)}  ` +
      `scrolls ${String(verdict.scrolls)}`,
  )
  lines.push(
    `writes ${String(verdict.writes.taken)} taken / ${String(verdict.writes.held)} held  ` +
      `peak ${px(verdict.heldPeak)}`,
  )

  // Only when non-zero. A row of zeros reads as reassurance, and on a small screen it also
  // costs the space the suspects need.
  const reasons = Object.entries(verdict.writes.byReason).filter(([, count]) => count > 0)
  if (reasons.length > 0) {
    lines.push(`  by reason: ${reasons.map(([r, c]) => `${r}=${String(c)}`).join(' ')}`)
  }

  if (verdict.worstScrollGapMs > 0) {
    lines.push(
      `worst gap ${ms(verdict.worstScrollGapMs)}` +
        (verdict.frozenMs > 0 ? `  frozen ${ms(verdict.frozenMs)}` : '') +
        (verdict.longestFrameMs > 0 ? `  frame ${ms(verdict.longestFrameMs)}` : ''),
    )
  }
  if (verdict.fold !== null) {
    lines.push(
      `fold ${px(verdict.fold.shift)}` +
        (verdict.fold.clamped ? ' CLAMPED' : '') +
        (verdict.fold.discontinuity > 0.5 ? ` off by ${px(verdict.fold.discontinuity)}` : ' clean'),
    )
  }
  if (verdict.measure.batches > 0) {
    lines.push(
      `measure ${String(verdict.measure.batches)} batches ${ms(verdict.measure.totalMs)}` +
        `  worst ${ms(verdict.measure.worstMs)}` +
        (verdict.measure.invalidations > 0
          ? `  invalidated ${String(verdict.measure.invalidations)}×`
          : ''),
    )
  }

  lines.push('')

  if (verdict.truncated) {
    // Said instead of a suspect list, not alongside one. See `recorder.ts` for why a verdict
    // from a partial record is worse than no verdict.
    lines.push('RECORD TRUNCATED — the ring dropped this')
    lines.push('gesture’s start, so nothing is ranked.')
    lines.push('Raise the capacity or filter topics.')
    return lines.join('\n')
  }

  if (verdict.suspects.length === 0) {
    lines.push('no suspect found')
    if (verdict.probeRunning) lines.push('(frame probe on — it perturbs timing)')
    return lines.join('\n')
  }

  for (const suspect of verdict.suspects) {
    lines.push(`${suspect.confidence === 'confirmed' ? '!!' : ' ?'} ${suspect.id}`)
    // Wrapped by hand at 42 columns rather than left to the browser, so the box height stays
    // predictable and the last suspect is not the one that falls off the bottom.
    for (const line of wrap(suspect.evidence, 42)) lines.push(`   ${line}`)
  }
  if (verdict.probeRunning) lines.push('(frame probe on — it perturbs timing)')

  return lines.join('\n')
}

/** Greedy word wrap. */
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line.length === 0) {
      line = word
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`
    } else {
      out.push(line)
      line = word
    }
  }
  if (line.length > 0) out.push(line)
  return out
}
