import { expect, test } from '@playwright/test'
import {
  distanceFromBottom,
  open,
  settle,
  TOLERANCE,
  visibleRowTops,
  worstMovement,
} from './helpers.js'

/**
 * Following the output of a list that is still growing.
 *
 * The claim is narrow and worth stating precisely: while the reader is at the end,
 * comments arriving keep them at the end; while they are not, comments arriving do
 * not move them at all. The second half is what the anchor already did, and it is
 * the half every other library struggles with — this suite exists to check that
 * adding the first half did not cost it.
 */

/**
 * A following list with the whole thread already loaded.
 *
 * `loadAll` matters: without it, reaching the end fires the demo's own
 * `onEdgeReached` and a page arrives, so the bottom moves away again while the
 * re-pin is still being decided. That is realistic, and it is the pagination
 * suite's subject — here it just makes every assertion about two features at
 * once. With nothing left to fetch, these tests are about following alone.
 */
const FOLLOWING = 'loadAll=1&follow=1&paddingStart=64'

/**
 * Wheel downwards until the scroller is genuinely at its end.
 *
 * A single large delta is not enough and never could be: wheel deltas are not
 * pixels, they differ per engine, and scrolling up here crosses the start edge
 * and fetches an older page — so the distance back down is longer than the
 * distance up was. Converging on the condition is the only stable way to say
 * "the reader scrolled back to the bottom", and it has to be real wheel input
 * because a scripted offset is deliberately not read as intent.
 */
async function wheelToBottom(page: Parameters<typeof open>[0]): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    // The library's own predicate, not a pixel tolerance: re-pinning is decided
    // by `atBottomThreshold` (4px), and wheel input cannot reliably land inside
    // half a pixel of the maximum on an engine that truncates scroll offsets.
    if (await page.evaluate(() => window.__list.isAtBottom())) return
    await page.mouse.wheel(0, 2000)
    await settle(page)
  }
  // Loudly, rather than letting the next assertion report a confusing distance.
  throw new Error(
    `wheelToBottom gave up ${String(await distanceFromBottom(page))}px from the bottom`,
  )
}

/**
 * Wheel upwards until the library agrees the reader has left the end.
 *
 * The mirror of {@link wheelToBottom}, and needed for the same reason: a wheel
 * takes effect asynchronously, so a fixed delta followed by a fixed wait is a
 * guess about how fast the machine is. Under load Firefox reported itself still
 * at the bottom two frames after a 3000px wheel — the *precondition* failing,
 * before the behaviour under test had been exercised at all.
 */
async function wheelAwayFromBottom(page: Parameters<typeof open>[0]): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!(await page.evaluate(() => window.__list.isAtBottom()))) return
    await page.mouse.wheel(0, -1500)
    await settle(page)
  }
  throw new Error('wheelAwayFromBottom never left the end of the list')
}

/**
 * Wait until the scroller has been quiet for longer than the engine's re-pin window.
 *
 * Not `scrollend`: the engine re-pins on a 150ms quiet timer *and* on `scrollend`,
 * whichever comes first, precisely because Firefox has the event and does not
 * always send it. Waiting on the event alone therefore waits for something that
 * need not happen, and waiting a fixed duration guesses at machine speed.
 *
 * Watching for silence covers both. Our window is twice the engine's and starts
 * no earlier — it is armed by the same scroll events — so by the time this
 * resolves the engine's timer has necessarily already fired.
 */
function waitForScrollQuiet(page: Parameters<typeof open>[0]): Promise<void> {
  return page.evaluate(
    (quietMs) =>
      new Promise<void>((resolve) => {
        const scroller = document.querySelector('.scroller')
        if (!scroller) {
          resolve()
          return
        }
        let timer = 0
        const finish = (): void => {
          scroller.removeEventListener('scroll', restart)
          resolve()
        }
        function restart(): void {
          clearTimeout(timer)
          timer = window.setTimeout(finish, quietMs)
        }
        scroller.addEventListener('scroll', restart)
        restart()
      }),
    300,
  )
}

test.describe('followOutput', () => {
  test('opens at the newest comment', async ({ page }) => {
    await open(page, FOLLOWING)
    expect(await distanceFromBottom(page)).toBeLessThanOrEqual(TOLERANCE)
    expect(await page.evaluate(() => window.__list.isAtBottom())).toBe(true)
  })

  test('stays at the end as comments arrive', async ({ page }) => {
    await open(page, FOLLOWING)

    for (let round = 0; round < 3; round++) {
      await page.evaluate(() => window.__list.insert('below', 5))
      await settle(page)
      expect(
        await distanceFromBottom(page),
        `still pinned after round ${String(round + 1)}`,
      ).toBeLessThanOrEqual(TOLERANCE)
    }
  })

  test('lets go once the reader scrolls up, and does not drag them back', async ({ page }) => {
    await open(page, FOLLOWING)

    // A real wheel, because input is what the library watches — an offset written
    // by a script is indistinguishable from the browser clamping, and is
    // deliberately not treated as intent.
    await page.locator('.scroller').hover()
    await wheelAwayFromBottom(page)
    expect(await page.evaluate(() => window.__list.isAtBottom())).toBe(false)
    const before = await visibleRowTops(page)

    await page.evaluate(() => window.__list.insert('below', 20))
    await settle(page)

    // Where the *rows* are, not what `scrollTop` reads. Scrolling up can cross the
    // start edge and fetch an older page, and a prepend is supposed to change
    // `scrollTop` by the height of what arrived while leaving the view alone —
    // asserting on the offset would call the library's central guarantee a failure.
    const moved = worstMovement(before, await visibleRowTops(page))
    expect(moved, 'no shared rows — the view changed entirely').not.toBeNull()
    expect(moved).toBeLessThanOrEqual(TOLERANCE)
  })

  test('takes hold again when the reader scrolls back to the end', async ({ page }) => {
    await open(page, FOLLOWING)

    await page.locator('.scroller').hover()
    await wheelAwayFromBottom(page)
    expect(await page.evaluate(() => window.__list.isAtBottom())).toBe(false)

    await wheelToBottom(page)
    await waitForScrollQuiet(page)
    expect(await page.evaluate(() => window.__list.isAtBottom())).toBe(true)

    // The strict part: with following re-engaged, the append writes the exact
    // maximum, so this is sub-pixel rather than within the 4px re-pin threshold.
    await page.evaluate(() => window.__list.insert('below', 10))
    await settle(page)
    expect(await distanceFromBottom(page)).toBeLessThanOrEqual(TOLERANCE)
  })

  test('survives a momentum fling on WebKit', async ({ page, browserName }) => {
    // iOS defers scroll writes during touch and momentum, banking them in
    // `deferredCorrection`. A follow write lands in exactly that path, so the one
    // engine that truncates scroll offsets is the one to check it against.
    test.skip(browserName !== 'webkit', 'the deferred-write path is WebKit’s')

    await open(page, FOLLOWING)
    await page.locator('.scroller').hover()

    // A hard fling upward, then back to the end.
    await page.mouse.wheel(0, -8000)
    await settle(page)
    await wheelToBottom(page)
    await waitForScrollQuiet(page)

    await page.evaluate(() => window.__list.insert('below', 5))
    await settle(page)

    expect(await distanceFromBottom(page)).toBeLessThanOrEqual(TOLERANCE)
  })

  test('is off by default, and an append leaves the reader alone', async ({ page }) => {
    await open(page, 'loadAll=1&paddingStart=64&comment=4211')
    const before = await visibleRowTops(page)

    await page.evaluate(() => window.__list.insert('below', 20))
    await settle(page)

    const moved = worstMovement(before, await visibleRowTops(page))
    expect(moved, 'no shared rows — the view changed entirely').not.toBeNull()
    expect(moved).toBeLessThanOrEqual(TOLERANCE)
  })
})

test.describe('alignToBottom', () => {
  test('holds a thread too short to scroll against the bottom', async ({ page }) => {
    // `loadAll` is off and the window is small, but the thread is still long — so
    // this asks for a genuinely short list by loading a window around the very end
    // and letting the demo cap it. What matters is the shape: when there is nothing
    // to scroll, the last comment sits at the bottom rather than the top.
    await open(page, 'alignToBottom=1&paddingStart=0&comment=11999')

    const gap = await page.locator('.scroller').evaluate((el) => {
      const rows = [...el.querySelectorAll('[data-virtual-key]')]
      const last = rows.at(-1)
      if (!last) return null
      return el.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom
    })

    expect(gap).not.toBeNull()
    // The last comment ends at the bottom of the scrollport, not hundreds of pixels
    // above it with empty space below.
    expect(Math.abs(gap ?? 0)).toBeLessThan(4)
  })
})
