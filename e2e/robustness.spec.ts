import { expect, test, type Page } from '@playwright/test'

/**
 * The cases the plan promised and the suite did not cover.
 *
 * Each one is a specific claim made in the README or the design notes that had no test
 * behind it: that a late font swap does not drift the view, that an item growing across
 * the top fold does not jump it, that a prepend arriving mid-animation does not break a
 * smooth scroll's landing, and that `once: true` reports an item exactly once.
 */

interface Anchor {
  key: string
  offsetWithinItem: number
}

interface ScrollApi {
  getAnchor: () => Anchor | null
  scrollToKey: (
    key: string,
    options?: unknown,
  ) => Promise<{ settled: boolean; deviation: number; reason: string }>
  loadOlder: () => Promise<number>
  forceLoadOlder: () => Promise<number>
  maxEnterCount: () => number
  enterCount: (key: string) => number
}

/**
 * Declared rather than wrapped in a helper: `page.evaluate` runs its callback in the
 * page, so anything it calls has to exist there. A helper defined in this file is a Node
 * binding and is simply not in scope inside the browser.
 */
declare global {
  interface Window {
    __list: ScrollApi
  }
}

const open = async (page: Page, query = ''): Promise<void> => {
  await page.goto(`/?${query}`)
  await page.waitForFunction(() => '__list' in window)
  await page.locator('[role="article"]').first().waitFor()
  await expect(page.locator('.panel .small').first()).toContainText('settled=', {
    timeout: 15_000,
  })
}

/** Where a given comment sits relative to the scrollport, in CSS pixels. */
const topOf = (page: Page, index: number): Promise<number> =>
  page.evaluate((i) => {
    const item = document
      .querySelector(`[data-comment-index="${String(i)}"]`)
      ?.closest('[role="article"]')
    if (!item) return Number.NaN
    const scroller = document.querySelector('.scroller')
    if (!scroller) return Number.NaN
    return item.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }, index)

/**
 * Where a row sits relative to the scrollport, addressed by key.
 *
 * By key rather than by index, because the invariant these tests check is about the
 * *anchored* item, and which item that is has to come from the library rather than be
 * guessed from geometry. Guessing it read the row whose top sat exactly on the fold,
 * while the anchor was the row the fold cut *through* — so the assertion held on
 * Chromium and failed on WebKit for reasons that had nothing to do with either.
 */
const topOfKey = (page: Page, key: string): Promise<number> =>
  page.evaluate((k) => {
    const row = document.querySelector(`[data-virtual-key="${k}"]`)
    const scroller = document.querySelector('.scroller')
    if (!row || !scroller) return Number.NaN
    return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }, key)

/** The item the library has pinned the view to. */
const anchorOf = (page: Page): Promise<Anchor | null> =>
  page.evaluate(() => window.__list.getAnchor())

/** The index encoded in a `comment-N` key. */
const indexOfKey = (key: string): number => Number.parseInt(key.slice('comment-'.length), 10)

test.describe('late measurement changes do not drift the view', () => {
  test('a font swap after mount leaves the anchored comment where it was', async ({
    page,
  }) => {
    // The promise: when a webfont arrives and every item re-measures, the item under the
    // anchor stays put. Simulated by a style change that alters wrapping — the same
    // event from the library's side, since all it sees is every size changing at once.
    await open(page, 'comment=4000')

    const anchor = await anchorOf(page)
    expect(anchor, 'no anchor to hold').not.toBeNull()
    const key = anchor?.key ?? ''
    const before = await topOfKey(page, key)

    await page.addStyleTag({
      content: '.comment { letter-spacing: 0.45px; word-spacing: 1.5px; }',
    })
    // Let the ResizeObserver batch land and the anchor be restored from it.
    await page.waitForTimeout(400)

    const after = await topOfKey(page, key)
    expect(
      Math.abs(after - before),
      `anchored ${key} moved from ${String(before)} to ${String(after)}`,
    ).toBeLessThanOrEqual(1)
  })

  test('an item growing across the top fold does not jump the view', async ({ page }) => {
    // TanStack Virtual #1218: the item the fold cuts through changes size, and because
    // part of it is above the viewport top, a naive implementation shifts everything.
    // The anchor holds the *offset within* that item, so its top edge must not move and
    // the growth must go downwards.
    await open(page, 'comment=4000')

    const anchor = await anchorOf(page)
    const key = anchor?.key ?? ''
    // The anchor is by definition the row the fold cuts through, so growing it is
    // exactly the reported case: part of it is above the viewport top.
    const index = indexOfKey(key)
    const before = await topOfKey(page, key)
    const nextBefore = await topOf(page, index + 1)

    await page.addStyleTag({
      content: `[data-comment-index="${String(index)}"] { padding-bottom: 220px; }`,
    })
    await page.waitForTimeout(400)

    const after = await topOfKey(page, key)
    const nextAfter = await topOf(page, index + 1)

    expect(
      Math.abs(after - before),
      `fold-spanning ${key} moved from ${String(before)} to ${String(after)}`,
    ).toBeLessThanOrEqual(1)
    // And the growth did land — it pushed what follows down rather than doing nothing.
    expect(nextAfter - nextBefore).toBeGreaterThan(200)
  })
})

test.describe('a prepend during an in-flight smooth scroll', () => {
  test('still lands on the target', async ({ page }) => {
    // Every prepended page moves every offset below it, so the target moves *while the
    // animation is running*. The target is recomputed each frame rather than captured at
    // the start, which is what makes this survivable at all.
    // Not `loadAll`, because this test needs real paging. The target sits near the *top*
    // of the loaded window, which is both the realistic case — you scroll up, which is
    // what triggers a prepend — and the only one where `align: 'start'` is reachable:
    // aiming at an item 2 rows from the end of the window clamps at the bottom, and a
    // clamped landing proves nothing about accuracy.
    await open(page, 'comment=6000')

    const result = await page.evaluate(async () => {
      const list = window.__list
      const scroll = list.scrollToKey('comment-5988', { align: 'start', behavior: 'smooth' })
      // Mid-flight, not before: pages arriving while the approach is still running. The
      // demo defers loads during a programmatic scroll by design, so this deliberately
      // goes around that — the landing has to be right either way.
      await new Promise((resolve) => setTimeout(resolve, 100))
      await list.forceLoadOlder()
      await list.forceLoadOlder()
      return scroll
    })

    expect(result.settled, `reason=${result.reason}`).toBe(true)

    const top = await topOf(page, 5988)
    // 64px is the sticky header, which `scrollPaddingStart` accounts for.
    expect(Math.abs(top - 64), `landed at ${String(top)}`).toBeLessThan(0.5)
  })
})

test.describe('once: true', () => {
  test('reports a comment exactly once however often it re-enters', async ({ page }) => {
    // The demo runs `once: false` by default, so the promised `once` semantics had no
    // coverage at all. Here a comment is scrolled away and back three times.
    await open(page, 'comment=200&once=1&loadAll=1')

    for (let round = 0; round < 3; round++) {
      await page.evaluate(async () => {
        await window.__list.scrollToKey('comment-800', { align: 'start' })
      })
      // Long enough to clear the 600ms dwell, so a re-entry would be reported.
      await page.waitForTimeout(750)
      await page.evaluate(async () => {
        await window.__list.scrollToKey('comment-200', { align: 'start' })
      })
      await page.waitForTimeout(750)
    }

    const max = await page.evaluate(() => window.__list.maxEnterCount())
    expect(max, 'a comment was reported more than once under once: true').toBe(1)

    // And it was reported at all — a rule that never fires would also pass the above.
    const seen = await page.evaluate(() => window.__list.enterCount('comment-200'))
    expect(seen).toBe(1)
  })

  test('reports every re-entry when once is off', async ({ page }) => {
    // The control case: without it, the assertion above proves nothing about `once`.
    await open(page, 'comment=200&loadAll=1')

    for (let round = 0; round < 2; round++) {
      await page.evaluate(async () => {
        await window.__list.scrollToKey('comment-800', { align: 'start' })
      })
      await page.waitForTimeout(750)
      await page.evaluate(async () => {
        await window.__list.scrollToKey('comment-200', { align: 'start' })
      })
      await page.waitForTimeout(750)
    }

    expect(await page.evaluate(() => window.__list.maxEnterCount())).toBeGreaterThan(1)
  })
})
