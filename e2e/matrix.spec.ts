import { expect, test } from '@playwright/test'
import {
  distanceFromBottom,
  headerHeight,
  measure,
  open,
  scrollTo,
  settle,
  setWindowAround,
  TOLERANCE,
  visibleRowTops,
  worstMovement,
  type ScrollOptions,
  type View,
} from './helpers.js'

/**
 * The accuracy matrix the plan actually promised.
 *
 * The original suite proved `< 0.5px` for `align: 'start'`, with a 64px header, no
 * `scrollMargin`, on the inner scroller, with `smooth` run once — four of five promised
 * dimensions were single-valued. Every target was also item ~20 of a 40-item window,
 * because the harness reset the window before scrolling, so the 12,000-comment thread
 * existed only as `aria-setsize` metadata and no long scroll distance or large offset
 * tree was ever exercised.
 *
 * The demo is parameterised from the URL, so all of it runs against one build.
 */

interface Scenario {
  name: string
  query: string
  windowScroller?: boolean
  /**
   * Whether the whole thread is loaded.
   *
   * The paged case is a genuinely different regime — a 40-comment window whose neighbours
   * are unmeasured — so it is a scenario here rather than a second spec file with its own
   * copy of the harness.
   */
  paged?: boolean
  /**
   * Height of the scenario's sticky footer slot, which shrinks the visible area.
   *
   * Declared here rather than measured, unlike the sticky *header*: the demo's page
   * header wraps as the window narrows, so its height genuinely has to be observed;
   * the composer is a fixed box set from the same URL parameter the library measures,
   * which makes this the independent check that the two agree.
   */
  stickyFooter?: number
}

const SCENARIOS: Scenario[] = [
  {
    name: 'inner scroller, a sticky header',
    query: 'paddingStart=64',
  },
  { name: 'inner scroller, no header', query: 'paddingStart=0' },
  {
    name: 'inner scroller, measured slots above and below the list',
    query: 'paddingStart=64&header=300&footer=200&stickyFooter=80',
    stickyFooter: 80,
  },
  {
    name: 'window scroller',
    query: 'paddingStart=0&windowScroller=1',
    windowScroller: true,
  },
  {
    name: 'a 40-comment paged window',
    query: 'paddingStart=64',
    paged: true,
  },
]

/** Targets deep enough that a large loaded window and long scroll distance are real. */
const TARGETS = [137, 1013, 4211, 7777, 11_500]
const ALIGNMENTS = ['start', 'center', 'end'] as const

/** Load the whole thread unless the scenario is specifically about paging. */
const openScenario = (page: Parameters<typeof open>[0], scenario: Scenario): Promise<void> =>
  open(page, scenario.paged ? scenario.query : `loadAll=1&${scenario.query}`)

/**
 * What a landing has to satisfy in this scenario.
 *
 * The top inset is the header's measured height rather than the number in the URL: the demo's
 * header wraps as the window narrows, so the two are the same only when it fits on one row.
 */
const viewOf = async (page: Parameters<typeof open>[0], scenario: Scenario): Promise<View> => ({
  paddingStart: await headerHeight(page),
  ...(scenario.stickyFooter === undefined ? {} : { paddingEnd: scenario.stickyFooter }),
  ...(scenario.windowScroller === true ? { windowScroller: true } : {}),
})

/** In the paged regime the target has to be brought into the window first. */
const aim = async (
  page: Parameters<typeof open>[0],
  scenario: Scenario,
  index: number,
  options: ScrollOptions,
): ReturnType<typeof scrollTo> => {
  if (scenario.paged) await setWindowAround(page, index)
  return scrollTo(page, index, options)
}

for (const scenario of SCENARIOS) {
  test.describe(`accuracy matrix — ${scenario.name}`, () => {
    for (const align of ALIGNMENTS) {
      test(`lands within half a pixel for align ${align}`, async ({ page }) => {
        await openScenario(page, scenario)

        const failures: string[] = []
        for (const index of TARGETS) {
          const result = await aim(page, scenario, index, { align })
          const landing = await measure(page, index, align, await viewOf(page, scenario))

          if (!landing.found) {
            failures.push(`#${String(index)}: not mounted`)
            continue
          }
          if (landing.clamped) continue
          if (Math.abs(landing.error) > TOLERANCE) {
            failures.push(
              `#${String(index)}: off by ${landing.error.toFixed(3)}px ` +
                `(settled=${String(result.settled)} reason=${result.reason})`,
            )
          }
        }

        expect(failures, `align ${align}:\n${failures.join('\n')}`).toEqual([])
      })
    }

    test('lands within half a pixel after a smooth scroll', async ({ page }) => {
      await openScenario(page, scenario)

      const failures: string[] = []
      for (const index of [1013, 7777]) {
        const result = await aim(page, scenario, index, { align: 'start', behavior: 'smooth' })
        const landing = await measure(page, index, 'start', await viewOf(page, scenario))
        if (landing.clamped) continue

        // Where it landed is the promise, and it is asserted strictly.
        if (Math.abs(landing.error) > TOLERANCE) {
          failures.push(
            `#${String(index)}: off by ${landing.error.toFixed(3)}px ` +
              `(settled=${String(result.settled)} reason=${result.reason})`,
          )
          continue
        }

        // Whether it converged *within its time budget* is not. The loop is bounded by
        // wall clock on purpose — 2s soft, 5s hard — so that it cannot hang, which means
        // a machine slow enough to spend the budget measuring will legitimately report
        // `deadline`. Asserting `settled` unconditionally asserts the speed of the
        // machine; this observed run failed once in roughly 400 with the landing still
        // exact. A deadline is only accepted *because* the landing above was exact.
        if (!result.settled && result.reason !== 'deadline') {
          failures.push(`#${String(index)}: reason=${result.reason}`)
        }
      }

      expect(failures, `smooth:\n${failures.join('\n')}`).toEqual([])
    })

    test('reports settled with no leftover deviation', async ({ page }) => {
      await openScenario(page, scenario)

      for (const index of [137, 4211]) {
        const result = await aim(page, scenario, index, { align: 'start' })
        expect(result.settled, `#${String(index)} ${result.reason}`).toBe(true)
        expect(Math.abs(result.deviation)).toBeLessThan(TOLERANCE)
      }
    })
  })
}

test.describe('accuracy matrix — deep targets in a fully loaded thread', () => {
  test('lands exactly on the last comment of 12,000', async ({ page }) => {
    // With the whole thread loaded this is a genuinely long scroll over a large Fenwick
    // tree, which the original suite never exercised: it reset the window to 40 items
    // before every scroll, so every target was item ~20 of 40.
    await openScenario(page, SCENARIOS[0]!)

    const result = await scrollTo(page, 11_999, { align: 'end' })
    expect(result.settled).toBe(true)

    const atBottom = await page.locator('.scroller').evaluate((el) => {
      const max = el.scrollHeight - el.clientHeight
      return max - el.scrollTop
    })
    expect(atBottom).toBeLessThanOrEqual(TOLERANCE)
  })

  test('holds sub-pixel accuracy across many consecutive jumps', async ({ page }) => {
    // Drift, if any, accumulates.
    await openScenario(page, SCENARIOS[0]!)

    const failures: string[] = []
    for (const index of [500, 9000, 1200, 11_000, 300, 6000]) {
      await scrollTo(page, index, { align: 'start' })
      const landing = await measure(page, index, 'start', await viewOf(page, SCENARIOS[0]!))
      if (!landing.clamped && Math.abs(landing.error) > TOLERANCE) {
        failures.push(`#${String(index)}: off by ${landing.error.toFixed(3)}px`)
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  })
})

test.describe('measured slots', () => {
  const SLOTS = 'loadAll=1&paddingStart=64&header=300&footer=200&stickyFooter=80'

  test('a header that grows does not move the view by a pixel', async ({ page }) => {
    // The whole reason the slots can be measured at all. Every other virtual list
    // either refuses to measure this content or measures it and lets the view jump —
    // virtua #458, react-virtuoso #1245. Here the anchor names a comment, so a header
    // growing by 400px moves `scrollTop` by 400px and the comment does not move.
    await open(page, SLOTS)
    await scrollTo(page, 4211, { align: 'start' })

    const before = await visibleRowTops(page)
    const anchorBefore = await page.evaluate(() => window.__list.getAnchor())

    await page.evaluate(() => window.__list.setHeaderHeight(700))
    await settle(page)

    const after = await visibleRowTops(page)
    const moved = worstMovement(before, after)
    expect(moved, 'no shared rows — the view changed entirely').not.toBeNull()
    expect(moved).toBeLessThanOrEqual(TOLERANCE)

    // And the position of record is untouched, not merely compensated back.
    expect(await page.evaluate(() => window.__list.getAnchor())).toEqual(anchorBefore)
  })

  test('a shrinking header holds the view too', async ({ page }) => {
    // The other direction, which is the one an unmount takes: react-virtuoso #1203 is a
    // header height that outlived its header as space nothing could account for.
    await open(page, SLOTS)
    await scrollTo(page, 4211, { align: 'start' })

    const before = await visibleRowTops(page)
    await page.evaluate(() => window.__list.setHeaderHeight(60))
    await settle(page)

    const moved = worstMovement(before, await visibleRowTops(page))
    expect(moved, 'no shared rows — the view changed entirely').not.toBeNull()
    expect(moved).toBeLessThanOrEqual(TOLERANCE)
  })

  test('align end on the last comment stops at the comment, not the footer', async ({ page }) => {
    // Without `spaceAfter` the end shortcut returns the browser's maximum scroll offset,
    // which with 200px of footer and an 80px composer below the list is 280px past where
    // the last comment should come to rest — so the comment would be off the top of the
    // screen by that much.
    await open(page, SLOTS)

    const result = await scrollTo(page, 11_999, { align: 'end' })
    expect(result.settled).toBe(true)

    const landing = await measure(page, 11_999, 'end', {
      paddingStart: await headerHeight(page),
      paddingEnd: 80,
    })
    expect(landing.found).toBe(true)
    expect(Math.abs(landing.error)).toBeLessThanOrEqual(TOLERANCE)

    // And it is genuinely short of the bottom, by the footer plus the composer.
    expect(await distanceFromBottom(page)).toBeGreaterThan(100)
  })
})
