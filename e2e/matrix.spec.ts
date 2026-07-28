import { expect, test, type Page } from '@playwright/test'

/**
 * The accuracy matrix the plan actually promised.
 *
 * The original suite proved `< 0.5px` for `align: 'start'`, with a 64px header, no
 * `scrollMargin`, on the inner scroller, with `smooth` run once — four of five promised
 * dimensions were single-valued. Every target was also item ~20 of a 40-item window,
 * because the harness reset the window before scrolling, so the 12,000-comment thread
 * existed only as `aria-setsize` metadata and no long scroll distance or large Fenwick
 * tree was ever exercised.
 *
 * The demo is now parameterised from the URL, so all of it runs against one build.
 */
const TOLERANCE = 0.5

interface Scenario {
  name: string
  query: string
  /** Height of chrome overlapping the top, which the target must land below. */
  paddingStart: number
  windowScroller?: boolean
}

const SCENARIOS: Scenario[] = [
  { name: 'inner scroller, 64px header', query: 'paddingStart=64', paddingStart: 64 },
  { name: 'inner scroller, no header', query: 'paddingStart=0', paddingStart: 0 },
  {
    name: 'inner scroller, content above the list',
    query: 'paddingStart=64&scrollMargin=300',
    paddingStart: 64,
  },
  {
    name: 'window scroller',
    query: 'paddingStart=0&windowScroller=1',
    paddingStart: 0,
    windowScroller: true,
  },
]

/** Targets deep enough that a large loaded window and long scroll distance are real. */
const TARGETS = [137, 1013, 4211, 7777, 11_500]
const ALIGNMENTS = ['start', 'center', 'end'] as const

interface Landing {
  found: boolean
  /** Signed px between where the item is and where the alignment asked for. */
  error: number
  clamped: boolean
}

/**
 * Measure where a comment landed, for any alignment and either scroller kind.
 *
 * Both the reference edge and the visible extent depend on the scroller, so the
 * measurement has to know which it is rather than assuming an inner element.
 */
async function measure(
  page: Page,
  index: number,
  align: 'start' | 'center' | 'end',
  scenario: Scenario,
): Promise<Landing> {
  return page.evaluate(
    ({ index, align, paddingStart, windowScroller }) => {
      const item = document
        .querySelector(`[data-comment-index="${String(index)}"]`)
        ?.closest('[role="article"]')
      if (!item) return { found: false, error: Number.NaN, clamped: false }

      const rect = item.getBoundingClientRect()

      let visibleTop: number
      let visibleBottom: number
      let atStart: boolean
      let atEnd: boolean

      if (windowScroller) {
        visibleTop = paddingStart
        visibleBottom = window.innerHeight
        const max = document.documentElement.scrollHeight - window.innerHeight
        atStart = window.scrollY <= 0.5
        atEnd = window.scrollY >= max - 0.5
      } else {
        const scroller = document.querySelector('.scroller')
        if (!scroller) return { found: false, error: Number.NaN, clamped: false }
        const box = scroller.getBoundingClientRect()
        // The content area starts inside the border, so `clientTop` has to be added —
        // forgetting it reads a 1px border as a 1px accuracy failure.
        visibleTop = box.top + scroller.clientTop + paddingStart
        visibleBottom = box.top + scroller.clientTop + scroller.clientHeight
        const max = scroller.scrollHeight - scroller.clientHeight
        atStart = scroller.scrollTop <= 0.5
        atEnd = scroller.scrollTop >= max - 0.5
      }

      const visibleSize = visibleBottom - visibleTop
      const expected =
        align === 'start'
          ? visibleTop
          : align === 'end'
            ? visibleBottom - rect.height
            : visibleTop + (visibleSize - rect.height) / 2

      return {
        found: true,
        error: rect.top - expected,
        // At either extreme, or for an item taller than the visible area, the requested
        // position can be unreachable and sitting at the boundary is correct.
        clamped: atStart || atEnd || rect.height > visibleSize,
      }
    },
    { index, align, paddingStart: scenario.paddingStart, windowScroller: scenario.windowScroller === true },
  )
}

interface ScrollApi {
  scrollToKey: (
    key: string,
    options?: unknown,
  ) => Promise<{ settled: boolean; deviation: number; reason: string }>
}

async function scrollTo(
  page: Page,
  index: number,
  options: { align: 'start' | 'center' | 'end'; behavior?: 'auto' | 'smooth' },
): Promise<{ settled: boolean; deviation: number; reason: string }> {
  return page.evaluate(
    async ({ index, options }) => {
      const api = (window as unknown as { __list: ScrollApi }).__list
      return api.scrollToKey(`comment-${String(index)}`, options)
    },
    { index, options },
  )
}

/** The whole thread loaded, so nothing is missing and no page load moves the target. */
const open = async (page: Page, scenario: Scenario): Promise<void> => {
  await page.goto(`/?loadAll=1&${scenario.query}`)
  await page.waitForFunction(() => '__list' in window)
  await page.locator('[role="article"]').first().waitFor()

  // The demo deep-links on first paint, two frames in. That scroll must finish before
  // the suite drives its own, or the app's lands second and reports the suite's as
  // `replaced` — which is correct behaviour and a broken test.
  await expect(page.locator('.panel .small').first()).toContainText('settled=', {
    timeout: 15_000,
  })
}

for (const scenario of SCENARIOS) {
  test.describe(`accuracy matrix — ${scenario.name}`, () => {
    for (const align of ALIGNMENTS) {
      test(`lands within half a pixel for align ${align}`, async ({ page }) => {
        await open(page, scenario)

        const failures: string[] = []
        for (const index of TARGETS) {
          const result = await scrollTo(page, index, { align })
          const landing = await measure(page, index, align, scenario)

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
      await open(page, scenario)

      const failures: string[] = []
      for (const index of [1013, 7777]) {
        const result = await scrollTo(page, index, { align: 'start', behavior: 'smooth' })
        const landing = await measure(page, index, 'start', scenario)
        if (landing.clamped) continue
        if (!result.settled || Math.abs(landing.error) > TOLERANCE) {
          failures.push(
            `#${String(index)}: off by ${landing.error.toFixed(3)}px ` +
              `(settled=${String(result.settled)} reason=${result.reason})`,
          )
        }
      }

      expect(failures, `smooth:\n${failures.join('\n')}`).toEqual([])
    })

    test('reports settled with no leftover deviation', async ({ page }) => {
      await open(page, scenario)

      for (const index of [137, 4211]) {
        const result = await scrollTo(page, index, { align: 'start' })
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
    await open(page, SCENARIOS[0]!)

    const result = await scrollTo(page, 11_999, { align: 'end' })
    expect(result.settled).toBe(true)

    const atBottom = await page.locator('.scroller').evaluate((el) => {
      const max = el.scrollHeight - el.clientHeight
      return max - el.scrollTop
    })
    expect(atBottom).toBeLessThanOrEqual(0.5)
  })

  test('holds sub-pixel accuracy across many consecutive jumps', async ({ page }) => {
    // Drift, if any, accumulates.
    await open(page, SCENARIOS[0]!)

    const failures: string[] = []
    for (const index of [500, 9000, 1200, 11_000, 300, 6000]) {
      await scrollTo(page, index, { align: 'start' })
      const landing = await measure(page, index, 'start', SCENARIOS[0]!)
      if (!landing.clamped && Math.abs(landing.error) > TOLERANCE) {
        failures.push(`#${String(index)}: off by ${landing.error.toFixed(3)}px`)
      }
    }
    expect(failures, failures.join('\n')).toEqual([])
  })
})
