/**
 * The motions, how each is produced, and the two observations that go with them.
 *
 * **What these prove and what they do not.** Automation cannot reproduce a human hand. What CDP's
 * `Input.synthesizeScrollGesture` *does* give — and `page.mouse.wheel` in a loop does not — is
 * input delivered at a rate the harness states rather than at a rate that depends on how fast the
 * machine round-trips. `follow.spec.ts:58` already makes that objection about fixed deltas
 * followed by fixed waits: "a fixed delta followed by a fixed wait is a guess about how fast the
 * machine is." A benchmark cannot afford that guess, because the guess is correlated with the
 * thing being measured.
 *
 * The touch motion is the one to read carefully. Chromium produces a genuine compositor fling
 * from a synthesized touch gesture, so the frame costs are real. But `isIOSWebKit()` is false in
 * Chromium, so `momentum.attach()` returns early and the write gate is inert — every correction
 * writes unconditionally. This therefore measures **the frame cost of touch-driven scrolling in
 * Chromium**, and says nothing at all about the iOS momentum gate that `e2e/ios-momentum.spec.ts`
 * exists for. Two different questions; this file answers only the first.
 */

import type { CDPSession, Page } from '@playwright/test'
import { settle } from '../e2e/helpers.js'

/** One CDP session per page, because attaching is not free and the session is reusable. */
const sessions = new WeakMap<Page, Promise<CDPSession>>()

function cdp(page: Page): Promise<CDPSession> {
  const existing = sessions.get(page)
  if (existing !== undefined) return existing
  const created = page.context().newCDPSession(page)
  sessions.set(page, created)
  return created
}

/**
 * The centre of the scrollport, in viewport CSS pixels — where a gesture has to originate.
 *
 * Cached per page, because resolving it is a selector lookup plus a protocol round trip, and a
 * motion is normally invoked *inside* the recording window: those milliseconds would otherwise be
 * recorded as ordinary idle frames and bias the sample toward the display rate. The scrollport
 * does not move while its contents scroll, which is the same fact `armBlankProbe` relies on.
 */
const centres = new WeakMap<Page, { x: number; y: number }>()

async function scrollerCentre(page: Page): Promise<{ x: number; y: number }> {
  const cached = centres.get(page)
  if (cached !== undefined) return cached
  const box = await page.locator('.scroller').boundingBox()
  if (box === null) throw new Error('no .scroller to gesture over')
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  centres.set(page, centre)
  return centre
}

/**
 * Resolve the CDP session and the gesture origin before anything is being timed.
 *
 * Call it after `open()`. Without it the first motion of a run pays for both inside the recording
 * window, which is a few idle milliseconds credited to the library as smooth frames.
 */
export async function warmUp(page: Page): Promise<void> {
  await cdp(page)
  await scrollerCentre(page)
}

export interface GestureOptions {
  /** How far to travel, in CSS pixels. Positive scrolls toward the end of the list. */
  distance: number
  /** Pixels per second. The whole point of using CDP: the rate is stated, not inferred. */
  speed: number
}

/**
 * Sustained wheel scrolling — the ordinary desktop case.
 *
 * `preventFling: true` because a wheel gesture should not hand off to momentum: what this
 * scenario is for is the cost of *continuous* input arriving frame after frame, which is the
 * regime where the engine's per-frame `publish` runs most often.
 */
export async function wheelScroll(page: Page, options: GestureOptions): Promise<void> {
  const { x, y } = await scrollerCentre(page)
  const session = await cdp(page)
  await session.send('Input.synthesizeScrollGesture', {
    x,
    y,
    // Negative scrolls toward the end: the protocol documents `yDistance` as "positive to
    // scroll up", which is the finger's direction rather than the content's.
    yDistance: -options.distance,
    speed: options.speed,
    preventFling: true,
    gestureSourceType: 'mouse',
  })
}

/**
 * A touch fling, followed by its momentum.
 *
 * The gesture command returns when the *finger* is done, not when the fling is. Momentum frames
 * are the interesting ones here, so the motion is not over until the scrollport stops moving —
 * a converging predicate rather than a fixed wait, for the reason `follow.spec.ts:58` gives.
 *
 * The waiting is done by the recorder's own rAF loop (`measure.ts`'s `waitForStill`) rather than
 * by a loop here. An earlier version ran its own, which meant two main-thread wakeups per frame
 * and a `scrollTop` read across precisely the momentum frames this motion exists to measure —
 * the instrument perturbing the only part of the run that was interesting.
 *
 * Six still frames rather than one, because a fling decelerates: a single frame with no change
 * happens mid-momentum on a slow tail and would end the recording early. The cap bounds the wait
 * so a scroller that never stops fails the test rather than hanging it.
 */
export async function touchFling(page: Page, options: GestureOptions): Promise<void> {
  const { x, y } = await scrollerCentre(page)
  const session = await cdp(page)
  await session.send('Input.synthesizeScrollGesture', {
    x,
    y,
    yDistance: -options.distance,
    speed: options.speed,
    preventFling: false,
    gestureSourceType: 'touch',
  })
  await page.evaluate(() => window.__perf.waitForStill(6, 600))
}

/**
 * Slow the renderer's main thread by a factor, or restore it with `1`.
 *
 * On a 60 Hz display a list that uses a fraction of the budget reports the same 60 FPS as one
 * that uses all of it, so the headline number cannot distinguish comfort from the edge. Throttling
 * converts the remaining headroom into something observable: the factor at which frames start to
 * drop is a property of the work per frame, and it is the figure that carries to a slower device.
 *
 * It emulates a slower CPU, not a different one — no cache hierarchy, no memory bandwidth, no
 * GPU. Treat the breaking point as an order of magnitude, not a specification.
 *
 * Apply it *after* the page has loaded. Applied before, it throttles the load as well, and the
 * measurement then starts against a list still catching up on its first measurements.
 */
export async function throttleCpu(page: Page, rate: number): Promise<void> {
  const session = await cdp(page)
  await session.send('Emulation.setCPUThrottlingRate', { rate })
}

/**
 * Capture composited frames while a motion runs, and return each frame's encoded size.
 *
 * **Why a screencast and not `page.screenshot()`.** A screenshot asks the browser for a fresh
 * capture, which waits for the main thread and therefore tends to photograph a *consistent*
 * frame — precisely hiding an artifact that exists only in frames the compositor presented on its
 * own. A screencast is a tap on the frames that were already going to the screen. It does not
 * force a sync, and it delivers what was actually seen.
 *
 * Sizes rather than pixels, because JPEG size is a serviceable proxy for how much is on screen
 * and needs no decoder: an empty scrollport encodes to a fraction of a full one. It is a proxy,
 * so every caller has to calibrate it against a known-empty control rather than assume a
 * threshold.
 */
export async function recordFrames(page: Page, motion: () => Promise<unknown>): Promise<number[]> {
  const session = await cdp(page)
  const sizes: number[] = []

  const onFrame = (event: { data: string; sessionId: number }): void => {
    sizes.push(event.data.length)
    // Acknowledged or the stream stops after a couple of frames. The failure is silent and looks
    // exactly like "nothing happened", so it is worth being explicit about. Not awaited:
    // serializing on the ack would throttle the stream being sampled.
    void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {
      /* the page can go away mid-flight; a lost ack is not a finding */
    })
  }

  session.on('Page.screencastFrame', onFrame)
  await session.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 })
  try {
    await motion()
    return sizes
  } finally {
    await session.send('Page.stopScreencast')
    session.off('Page.screencastFrame', onFrame)
  }
}

/** Where the scrollport currently is. Used to prove a motion actually moved something. */
export function scrollTop(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('.scroller')?.scrollTop ?? 0)
}

/**
 * Put the view back at the top between repetitions.
 *
 * A direct `scrollTop` write rather than `scrollToKey`, because this is not one of the motions
 * being measured and driving the API here would put its convergence loop inside the reset.
 *
 * One definition, shared by all three specs. It existed as three near-copies with two different
 * settle depths, which is the drift `e2e/helpers.ts:11` was written about.
 */
export async function resetToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const element = document.querySelector('.scroller')
    if (element !== null) element.scrollTop = 0
  })
  await settle(page)
}
