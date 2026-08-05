import { expect, test, type Page } from '@playwright/test'
import {
  headerHeight,
  open,
  scrollTo,
  SNAPSHOT_KEY,
  TOLERANCE,
  topOfKey,
  visibleRowTops,
  worstMovement,
} from './helpers.js'
import type { Anchor, ItemKey } from '../packages/virtual-anchor/src/index.js'

/**
 * The cases the plan promised and the suite did not cover.
 *
 * Each one is a specific claim made in the README or the design notes that had no test
 * behind it: that a late font swap does not drift the view, that an item growing across
 * the top fold does not jump it, that a prepend arriving mid-animation does not break a
 * smooth scroll's landing, and that `once: true` reports an item exactly once.
 */

/** The item the library has pinned the view to. */
const anchorOf = (page: Page): Promise<Anchor | null> =>
  page.evaluate(() => window.__list.getAnchor())

/** The index encoded in a `comment-N` key. */
/**
 * The comment number inside a `comment-N` key.
 *
 * Takes an `ItemKey` rather than a `string` because that is what an anchor
 * actually carries — keys are `string | number`, and every call site here comes
 * from `getAnchor()`. The narrower signature typechecked only because nothing
 * ran `tsc` over this directory.
 */
const indexOfKey = (key: ItemKey): number =>
  Number.parseInt(String(key).slice('comment-'.length), 10)

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
    const nextBefore = await topOfKey(page, `comment-${String(index + 1)}`)

    await page.addStyleTag({
      content: `[data-comment-index="${String(index)}"] { padding-bottom: 220px; }`,
    })
    await page.waitForTimeout(400)

    const after = await topOfKey(page, key)
    const nextAfter = await topOfKey(page, `comment-${String(index + 1)}`)

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
      await list.loadOlder(true)
      await list.loadOlder(true)
      return scroll
    })

    // Where it landed is the promise, and it is asserted strictly — before
    // anything is said about how long getting there took.
    const top = await topOfKey(page, 'comment-5988')
    // Below the sticky header, which is what `scrollPaddingStart` accounts for — measured,
    // because the header wraps onto more rows as the window narrows.
    const inset = await headerHeight(page)
    expect(Math.abs(top - inset), `landed at ${String(top)}, header is ${String(inset)}`).toBeLessThan(
      TOLERANCE,
    )

    // Whether it converged *within its time budget* is not, and asserting it
    // unconditionally was asserting the speed of the machine. The convergence loop
    // is bounded by wall clock on purpose — 2s soft, 5s hard — so it cannot hang;
    // a box slow enough to spend that budget re-measuring two forced prepends will
    // legitimately report `deadline`. Reproduced by oversubscribing Playwright's
    // workers, which starves frames the same way a loaded CI runner does.
    //
    // The same allowance, for the same reason, as the smooth case in
    // `matrix.spec.ts`. A `deadline` is only tolerable *because* the landing above
    // was exact: if the scroll had genuinely failed to arrive, this test would
    // already have failed one assertion earlier.
    if (!result.settled && result.reason !== 'deadline') {
      expect(result.settled, `reason=${result.reason}`).toBe(true)
    }
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

test.describe('a restored size snapshot', () => {
  test("survives the scrollport's first ResizeObserver delivery", async ({ page }) => {
    // Two defects met here. The scrollport's ResizeObserver fires a synthetic first
    // observation one frame after mount, which used to clear the whole cache — so every
    // restored size for an item not currently mounted was destroyed, and `lastSizes` meant
    // it could never be re-reported. And the React adapter forwarded `sizeSnapshot` only
    // through `setOptions`, which had no handler for it, so the feature did nothing at all
    // through the component.
    //
    // Asserted on what the list *has*, not on a trace event: tracing is compiled out of a
    // production build, and the demo under test is one.
    await open(page, 'comment=4000&snapshot=1')

    // Measure a decent number of comments, then persist as the demo does on unload.
    const persisted = await page.evaluate(async (key) => {
      sessionStorage.clear()
      const scroller = document.querySelector('.scroller')
      if (!scroller) return 0
      for (let step = 0; step < 8; step++) {
        scroller.scrollTop += 1500
        await new Promise(requestAnimationFrame)
        await new Promise(requestAnimationFrame)
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
      const snapshot = window.__list.takeSizeSnapshot()
      if (!snapshot) return 0
      sessionStorage.setItem(key, JSON.stringify(snapshot))
      return snapshot.sizes.length
    }, SNAPSHOT_KEY)
    expect(persisted).toBeGreaterThan(20)

    // Same tab, so sessionStorage carries over — as a reload would.
    await open(page, 'comment=4000&snapshot=1')

    // Immediately: every persisted size is present without having been re-measured, which
    // it cannot have been, since most of those comments are nowhere near the viewport.
    const immediately = await page.evaluate(
      () => window.__list.takeSizeSnapshot()?.sizes.length ?? 0,
    )
    expect(immediately, 'the snapshot never reached the cache').toBeGreaterThanOrEqual(
      persisted,
    )

    // A full second, well past the first ResizeObserver delivery.
    await page.waitForTimeout(1000)
    const stillHeld = await page.evaluate(
      () => window.__list.takeSizeSnapshot()?.sizes.length ?? 0,
    )
    expect(stillHeld).toBeGreaterThanOrEqual(persisted)
  })

  test('ignores one measured under a different layout', async ({ page }) => {
    // A height measured at a different width is wrong rather than stale, so the whole
    // snapshot is refused — restoring it would put the list confidently in the wrong place.
    await open(page, 'comment=4000&snapshot=1')

    await page.evaluate((key) => {
      const snapshot = window.__list.takeSizeSnapshot()
      if (!snapshot) return
      sessionStorage.setItem(
        key,
        JSON.stringify({
          ...snapshot,
          layoutSignature: 'measured-at-some-other-width',
          sizes: Array.from({ length: 40 }, (_, i) => [`comment-${String(3980 + i)}`, 999]),
        }),
      )
    }, SNAPSHOT_KEY)

    await open(page, 'comment=4000&snapshot=1')
    const measured = await page.evaluate(
      () => window.__list.takeSizeSnapshot()?.sizes.length ?? 0,
    )
    // Only what this page measured for itself, nowhere near the 40 offered.
    expect(measured).toBeLessThan(40)
  })
})

/**
 * A whole CSS pixel, rather than the half a `scrollToKey` landing promises.
 *
 * Each inserted comment measures after it mounts, and each measurement re-derives the scroll
 * offset from the anchor. Chromium and Firefox reclaim the sub-pixel remainder every time and
 * hold at 0.25px however many arrive; WebKit, which truncates a fractional `scrollTop`, keeps
 * about a quarter-pixel per correction — 0.75px for three comments. Measured, not guessed:
 * the anchor itself is identical before and after, and the scroll offset moves by exactly the
 * inserted height, so this is the platform's rounding rather than drift in the model.
 *
 * Still a tight bound: three comments are 359px of content, so a pixel is 0.3% of it.
 */
const INSERT_TOLERANCE = 1

test.describe('comments arriving while you read', () => {
  test('inserting above the view does not move the view', async ({ page }) => {
    // The demo's insert controls post comments outside the visible area, which is the claim
    // this library exists for: every index below the insertion shifts, and what the reader is
    // looking at must not move by a pixel. The demo measures it too and prints the number —
    // this asserts it.
    await open(page, 'comment=4000')

    for (const [label, direction] of [
      ['above view', 'above'],
      ['below view', 'below'],
    ] as const) {
      const before = await visibleRowTops(page)
      expect(Object.keys(before).length, 'nothing visible to watch').toBeGreaterThan(2)

      await page.getByRole('button', { name: label, exact: true }).click()
      await expect(page.locator('.panel .small').first()).toContainText(`inserted ${direction}`)

      const after = await visibleRowTops(page)
      expect(
        worstMovement(before, after),
        `inserting ${direction} the view moved something inside it`,
      ).toBeLessThanOrEqual(INSERT_TOLERANCE)
    }
  })

  test('reports the movement it caused, so the demo is not taking my word for it', async ({
    page,
  }) => {
    await open(page, 'comment=4000')

    await page.getByRole('button', { name: 'above view', exact: true }).click()
    await expect(page.locator('.panel .small').first()).toContainText('inserted above the view')

    // The demo's own measurement of the anchored row, which is the one that must not move.
    const reported = await page.locator('.panel .small').first().innerText()
    const moved = Number(/it moved ([\d.]+)px/.exec(reported)?.[1] ?? Number.NaN)
    expect(moved).toBeLessThanOrEqual(INSERT_TOLERANCE)
  })
})

test.describe('a sticky header that changes height', () => {
  test('lands below the header after it wraps onto more rows', async ({ page }) => {
    // A narrow window wraps the demo's header controls onto extra rows, so the top inset the
    // list has to respect grows at runtime. A landing that still aimed at the original height
    // would put the target *underneath* the header — visible to a reader, and exactly the kind
    // of thing a fixed number in a demo hides.
    await open(page, 'comment=4000')

    const wideHeader = await page.locator('.header').evaluate((el) => el.getBoundingClientRect().height)

    await page.setViewportSize({ width: 620, height: 800 })
    // Let the resize observer land and the list take the new inset.
    await expect
      .poll(async () => page.locator('.header').evaluate((el) => el.getBoundingClientRect().height))
      .toBeGreaterThan(wideHeader)

    const narrowHeader = await page
      .locator('.header')
      .evaluate((el) => el.getBoundingClientRect().height)

    // Aim again now the geometry has changed.
    await scrollTo(page, 4000, { align: 'start' })

    const landing = await page.evaluate((headerHeight) => {
      const row = document
        .querySelector('[data-comment-index="4000"]')
        ?.closest('[role="article"]')
      const scroller = document.querySelector('.scroller')
      if (!row || !scroller) return Number.NaN
      const contentTop = scroller.getBoundingClientRect().top + scroller.clientTop
      return row.getBoundingClientRect().top - contentTop - headerHeight
    }, narrowHeader)

    expect(Math.abs(landing), `landed ${String(landing)}px from below the header`).toBeLessThan(
      TOLERANCE,
    )
  })
})

/** A row's own border-box height, by virtual key. */
function rowHeight(page: Page, key: string): Promise<number> {
  return page.evaluate(
    (k) =>
      document.querySelector(`[data-virtual-key="${k}"]`)?.getBoundingClientRect().height ?? -1,
    key,
  )
}

/** The scrollport's own content height, which this case needs to stay put. */
function scrollportHeight(page: Page): Promise<number> {
  return page.locator('.scroller').evaluate((el) => el.clientHeight)
}

test.describe('a scrollport that changes width without changing height', () => {
  test('discards the heights measured at the old width', async ({ page }) => {
    // Issue #34, in a real browser. Everything else covering this drives *synthesised*
    // ResizeObserver deliveries, because jsdom performs no layout — so nothing else
    // exercises the thing that actually went wrong: a reflow that moves where text wraps
    // while leaving the scrollport exactly as tall as it was. That combination is the whole
    // defect, and it is not expressible without a layout engine.
    // The deep link is the scroll: `open` blocks until the demo reports `settled=`, which the
    // same effect that drove `scrollToKey('comment-400', { align: 'start' })` sets. So the
    // rows on the way there have been measured by the time this returns, and an explicit
    // `scrollTo` to the same key would be a round trip that changes nothing.
    await open(page, 'comment=400')

    const before = await page.evaluate(() => window.__list.takeSizeSnapshot())
    const measuredBefore = before?.sizes.length ?? 0
    // Guard the premise: with nothing measured there is nothing to invalidate, and the
    // assertions below would hold for the wrong reason.
    expect(measuredBefore).toBeGreaterThan(5)

    // A row that is actually on screen, not merely in the snapshot: most of what has been
    // measured was measured on the way past and is long unmounted, and an unmounted row has
    // no box to report a height for.
    const rowKey = await page.evaluate(
      () => document.querySelector('[data-virtual-key]')?.getAttribute('data-virtual-key') ?? '',
    )
    const heightBefore = await rowHeight(page, rowKey)
    expect(heightBefore).toBeGreaterThan(0)
    const scrollportBefore = await scrollportHeight(page)

    // Narrower, same height. 1150 is chosen against measurement, not by feel: at 1280 the
    // row is 277.25px tall, at 1150 it is 300.5px, and the scrollport is 635px at both. Go
    // much below 1050 and the demo's header controls wrap onto a second row, which takes 44px
    // off the scrollport and turns this into an ordinary two-axis resize.
    await page.setViewportSize({ width: 1150, height: 720 })

    // The honest signal that the reflow happened, rather than a timeout: a row that really
    // is a different height than it was.
    await expect.poll(() => rowHeight(page, rowKey)).not.toBe(heightBefore)

    // Load-bearing. If the scrollport's height moved too, this would be an ordinary resize
    // that the pre-fix code already caught, and the case would pass against the defect
    // rather than because of the fix. `a sticky header that changes height` above depends on
    // narrowing far enough to wrap the header; this one depends on not doing that, and says
    // so out loud rather than hoping.
    expect(
      await scrollportHeight(page),
      'the scrollport must not have changed height, or this exercises the wrong path',
    ).toBe(scrollportBefore)

    // Polled, not read once: the row height above changes at layout, and the library reacts
    // one `ResizeObserver` delivery later. Reading the snapshot straight after the reflow
    // catches WebKit mid-way and asserts against a cache that has not been told yet — which
    // is a race in the test, not in the library, and it fails only on WebKit.
    //
    // The key the cache is trusted against has to move, because nothing measured under the
    // old one may survive: a height taken at a different width is not stale, it is wrong.
    await expect
      .poll(() => page.evaluate(() => window.__list.takeSizeSnapshot()?.layoutSignature))
      .not.toBe(before?.layoutSignature)

    const after = await page.evaluate(() => window.__list.takeSizeSnapshot())
    expect(after?.sizes.length ?? 0).toBeLessThan(measuredBefore)
  })
})
