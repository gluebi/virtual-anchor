/**
 * Frame timing, so a cancelled fling can be told from a blocked main thread.
 *
 * Those two look identical from the outside — the content stops tracking the finger — and
 * they have opposite causes and opposite fixes. The trace can already say whether a
 * `scrollTop` write escaped; what it cannot say is whether *nothing* happened because the
 * main thread was busy. This measures that, and nothing else.
 *
 * ## Why it lives here and not in the core
 *
 * Not merely because it needs no library internals, though it does not. `scroller.step()`
 * deliberately **parks** — stops re-requesting frames — while the write gate is shut, and its
 * comment says why: re-requesting would "schedule a main-thread wakeup every frame for up to
 * `MOMENTUM_IDLE_MS` — hundreds of them, all guaranteed to do nothing — during the one moment
 * on iOS where contention is most visible." A frame probe in the core would put every one of
 * those wakeups back. Here, it is a cost the person measuring chooses knowingly.
 *
 * ## Two honesty requirements
 *
 * `PerformanceObserver` with `longtask` would be the right instrument and **is not available
 * in Safari** — the engine this exists for. So rAF gaps are the only portable signal on the
 * platform that matters, and they conflate "the main thread was blocked" with "the compositor
 * did not present a frame".
 *
 * And **the probe perturbs what it measures.** One callback per frame during a fling is not
 * free on a phone. `GestureVerdict.probeRunning` records that it was on, and the README tells
 * the reader to confirm any timing finding with it off. An instrument that hid this would be
 * inviting a conclusion about its own overhead.
 */

import { trace } from '../trace.js'
import { round } from './round.js'
import { createFrameDriver, type FrameDriver } from './driver.js'

export interface FrameProbeOptions {
  /** Report frames slower than this. Default 32 ms — two frames at 60 Hz. */
  longFrameMs?: number
  /** Share a driver with the overlay, so there is one rAF loop rather than two. */
  driver?: FrameDriver
  /**
   * Also sample `scrollTop` every frame. **Off by default, and think before turning it on.**
   *
   * Reading `scrollTop` in a rAF callback that runs after the library has written styles
   * forces a synchronous layout *every frame*, which changes the stall being hunted. It is
   * offered because "the content froze while the scrollport kept moving" is sometimes worth one
   * deliberate perturbation to confirm — but it is never the first thing to try.
   */
  sampleScrollTop?: { element: Element }
}

export interface FrameProbe {
  /** Emits `frame.summary` and detaches. */
  stop(): void
  /** The worst frame gap seen, for a caller that wants the number without waiting for the summary. */
  longest(): number
}

export function startFrameProbe(options: FrameProbeOptions = {}): FrameProbe {
  const longFrameMs = options.longFrameMs ?? 32
  const driver = options.driver ?? createFrameDriver()
  const sample = options.sampleScrollTop

  const startedAt = typeof performance === 'undefined' ? 0 : performance.now()
  let frames = 0
  let longest = 0
  let over = 0

  const stopFrames = driver.onFrame((_at, gap) => {
    frames++
    if (gap > longest) longest = gap
    if (gap > longFrameMs) {
      over++
      // Only the outliers. Emitting every frame would fill the recorder with the ordinary
      // 8ms and 16ms case and push the gesture that matters out of the ring.
      trace('frame.long', () => ({
        gap: round(gap),
        frames,
        ...(sample === undefined ? {} : { scrollTop: sample.element.scrollTop }),
      }))
    }
  })

  return {
    stop() {
      stopFrames()
      const now = typeof performance === 'undefined' ? 0 : performance.now()
      trace('frame.summary', () => ({
        frames,
        elapsed: round(now - startedAt),
        longest: round(longest),
        over,
      }))
    },
    longest: () => longest,
  }
}
