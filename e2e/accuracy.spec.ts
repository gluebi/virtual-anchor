import { expect, test, type Page } from '@playwright/test'

/**
 * The acceptance criterion: `scrollToKey` lands within half a pixel.
 *
 * Measured against the scrollport's *content* top, which means adding
 * `clientTop` — `getBoundingClientRect().top` is the border-box top, and
 * forgetting that reads a 1px border as a 1px accuracy failure. This bit the
 * residual-carry spike on its first run.
 */
const TOLERANCE = 0.5
const HEADER_HEIGHT = 64

interface Landing {
  /** Signed px between where the item is and where it was asked to be. */
  offsetFromContentTop: number
  found: boolean
  /**
   * Whether the scroller is pinned at an extreme.
   *
   * At `scrollTop === 0` or `scrollTop === max` the requested offset can be
   * physically unreachable — the first comment cannot sit 64px below the header
   * when there is nothing above it to scroll away. Landing "wrong" there is the
   * scroller obeying the browser, not an accuracy failure, so the assertion has
   * to know the difference.
   */
  clamped: boolean
}

/** Where a comment's top edge actually is, relative to the visible area's top. */
async function measureLanding(page: Page, commentIndex: number): Promise<Landing> {
  return page.evaluate(
    ({ index, headerHeight }) => {
      const scroller = document.querySelector('.scroller')
      const item = document
        .querySelector(`[data-comment-index="${String(index)}"]`)
        ?.closest('[role="article"]')

      if (!scroller || !item) {
        return { offsetFromContentTop: Number.NaN, found: false, clamped: false }
      }

      const contentTop = scroller.getBoundingClientRect().top + scroller.clientTop
      // `scrollPaddingStart` means the item should land below the sticky header,
      // so that is the reference point rather than the raw content top.
      const expectedTop = contentTop + headerHeight
      const maxScroll = scroller.scrollHeight - scroller.clientHeight

      return {
        offsetFromContentTop: item.getBoundingClientRect().top - expectedTop,
        found: true,
        clamped: scroller.scrollTop <= 0.5 || scroller.scrollTop >= maxScroll - 0.5,
      }
    },
    { index: commentIndex, headerHeight: HEADER_HEIGHT },
  )
}

async function scrollToComment(
  page: Page,
  commentIndex: number,
  options: { align?: 'start' | 'center' | 'end'; behavior?: 'auto' | 'smooth' } = {},
): Promise<{ settled: boolean; deviation: number; reason: string }> {
  return page.evaluate(
    async ({ index, opts }) => {
      const api = (window as unknown as { __list?: {
        scrollToKey: (key: string, o?: unknown) => Promise<{ settled: boolean; deviation: number; reason: string }>
        setWindowAround: (i: number) => void
      } }).__list
      if (!api) throw new Error('demo did not expose its list handle')

      api.setWindowAround(index)
      // Wait for the window change to actually reach the list. React flushes
      // state updates originating outside itself asynchronously, so a single
      // frame is not enough — scrolling too early resolves 'unknown-key'.
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise(requestAnimationFrame)
        if (document.querySelector(`[data-comment-index="${String(index)}"]`)) break
      }
      return api.scrollToKey(`comment-${String(index)}`, opts)
    },
    { index: commentIndex, opts: options },
  )
}

/**
 * Wait until the list is genuinely usable.
 *
 * The demo exposes its test handle from an effect, which can run before the
 * engine has received any items — and `scrollToKey` on an empty list correctly
 * resolves `{ reason: 'empty' }` rather than pretending. Waiting for the handle
 * alone is a race; waiting for mounted articles is not.
 */
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => '__list' in window)
  await page.locator('[role="article"]').first().waitFor()
}

/** Spread across the thread, including both extremes. */
const TARGETS = [0, 1, 17, 40, 137, 512, 1013, 2500, 4211, 7777, 9999, 11_998, 11_999]

test.describe('scrollToKey accuracy', () => {
  test('lands within half a pixel for align start', async ({ page }) => {
    await page.goto('/')
    await ready(page)

    const failures: string[] = []
    for (const index of TARGETS) {
      const result = await scrollToComment(page, index, { align: 'start' })
      const landing = await measureLanding(page, index)

      if (!landing.found) {
        failures.push(`#${String(index)}: not mounted after scroll`)
        continue
      }
      // At either extreme the requested offset can be unreachable; the scroller is
      // then correct to sit at the boundary instead.
      if (landing.clamped) continue

      if (Math.abs(landing.offsetFromContentTop) > TOLERANCE) {
        failures.push(
          `#${String(index)}: off by ${landing.offsetFromContentTop.toFixed(3)}px ` +
            `(settled=${String(result.settled)})`,
        )
      }
    }

    expect(failures, `landing failures:\n${failures.join('\n')}`).toEqual([])
  })

  test('sits exactly at the boundary for the first and last comments', async ({ page }) => {
    await page.goto('/')
    await ready(page)

    for (const [index, edge] of [
      [0, 'top'],
      [11_999, 'bottom'],
    ] as const) {
      await scrollToComment(page, index, { align: edge === 'top' ? 'start' : 'end' })
      const position = await page.locator('.scroller').evaluate((el) => ({
        scrollTop: el.scrollTop,
        max: el.scrollHeight - el.clientHeight,
      }))

      if (edge === 'top') expect(position.scrollTop).toBeLessThanOrEqual(0.5)
      else expect(position.max - position.scrollTop).toBeLessThanOrEqual(0.5)
    }
  })

  test('reports settled with no leftover deviation', async ({ page }) => {
    await page.goto('/')
    await ready(page)

    for (const index of [137, 4211, 9999]) {
      const result = await scrollToComment(page, index, { align: 'start' })
      expect(result.settled, `#${String(index)} should settle`).toBe(true)
      expect(Math.abs(result.deviation)).toBeLessThan(TOLERANCE)
    }
  })

  test('lands correctly for center and end alignment', async ({ page }) => {
    await page.goto('/')
    await ready(page)

    for (const align of ['center', 'end'] as const) {
      for (const index of [137, 4211]) {
        const result = await scrollToComment(page, index, { align })
        expect(result.settled, `#${String(index)} ${align}: ${JSON.stringify(result)}`).toBe(
          true,
        )

        // The item must be fully within the visible area for both alignments.
        const inView = await page.evaluate(
          ({ i, headerHeight }) => {
            const scroller = document.querySelector('.scroller')
            const item = document
              .querySelector(`[data-comment-index="${String(i)}"]`)
              ?.closest('[role="article"]')
            if (!scroller || !item) return null

            const scrollerRect = scroller.getBoundingClientRect()
            const itemRect = item.getBoundingClientRect()
            return {
              aboveFold: itemRect.top - (scrollerRect.top + headerHeight),
              belowFold: scrollerRect.bottom - itemRect.bottom,
              tallerThanViewport: itemRect.height > scrollerRect.height - headerHeight,
            }
          },
          { i: index, headerHeight: HEADER_HEIGHT },
        )

        expect(inView).not.toBeNull()
        if (inView && !inView.tallerThanViewport) {
          expect(inView.aboveFold, `#${String(index)} ${align} top edge`).toBeGreaterThan(-1)
          expect(inView.belowFold, `#${String(index)} ${align} bottom edge`).toBeGreaterThan(-1)
        }
      }
    }
  })

  test('lands within half a pixel after a smooth scroll', async ({ page }) => {
    await page.goto('/')
    await ready(page)

    // Pagination off for this one. The demo loads a page whenever the scroll nears
    // an edge, and a smooth scroll passing the top edge triggers a prepend every
    // ~120ms — which moves the target faster than any animation can converge on
    // it. That interaction is real and documented; it is not what this test is for.
    await page.evaluate(() => {
      ;(window as unknown as { __list: { setPaginationEnabled: (v: boolean) => void } }).__list.setPaginationEnabled(
        false,
      )
    })

    const result = await scrollToComment(page, 4211, { align: 'start', behavior: 'smooth' })
    expect(result.settled, `smooth result: ${JSON.stringify(result)}`).toBe(true)

    const landing = await measureLanding(page, 4211)
    expect(Math.abs(landing.offsetFromContentTop)).toBeLessThan(TOLERANCE)
  })

  test('deep-links from a cold start with nothing measured', async ({ page }) => {
    await page.goto('/?comment=8642')
    await expect(page.locator('.panel .small').first()).toContainText('settled=true', {
      timeout: 15_000,
    })

    const landing = await measureLanding(page, 8642)
    expect(landing.found).toBe(true)
    // Not merely in view — at the requested offset.
    expect(Math.abs(landing.offsetFromContentTop)).toBeLessThan(TOLERANCE)
  })
})

test.describe('prepend and append do not move the view', () => {
  test('holds position when older comments load at the top', async ({ page }) => {
    await page.goto('/?comment=4211')
    await expect(page.locator('.panel .small').first()).toContainText('settled=true', {
      timeout: 15_000,
    })

    const before = await measureLanding(page, 4211)
    expect(before.found).toBe(true)

    // A page of older comments arrives above the viewport.
    const grew = await page.evaluate(async () => {
      const api = (window as unknown as { __list?: { loadOlder: () => Promise<number> } }).__list
      if (!api) throw new Error('no handle')
      return api.loadOlder()
    })
    expect(grew).toBeGreaterThan(0)

    const after = await measureLanding(page, 4211)
    expect(
      Math.abs(after.offsetFromContentTop - before.offsetFromContentTop),
      `prepend moved the view: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    ).toBeLessThan(TOLERANCE)
  })

  test('holds position when newer comments load at the bottom', async ({ page }) => {
    await page.goto('/?comment=4211')
    await expect(page.locator('.panel .small').first()).toContainText('settled=true', {
      timeout: 15_000,
    })

    const before = await measureLanding(page, 4211)
    await page.evaluate(async () => {
      const api = (window as unknown as { __list?: { loadNewer: () => Promise<number> } }).__list
      if (!api) throw new Error('no handle')
      return api.loadNewer()
    })

    const after = await measureLanding(page, 4211)
    expect(
      Math.abs(after.offsetFromContentTop - before.offsetFromContentTop),
      `append moved the view: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    ).toBeLessThan(TOLERANCE)
  })

  test('holds position through repeated prepends', async ({ page }) => {
    await page.goto('/?comment=4211')
    await expect(page.locator('.panel .small').first()).toContainText('settled=true', {
      timeout: 15_000,
    })

    const before = await measureLanding(page, 4211)
    for (let i = 0; i < 5; i++) {
      await page.evaluate(async () => {
        const api = (window as unknown as { __list?: { loadOlder: () => Promise<number> } })
          .__list
        return api?.loadOlder()
      })
    }

    const after = await measureLanding(page, 4211)
    // Five pages of unmeasured comments inserted above, and still not a pixel.
    expect(
      Math.abs(after.offsetFromContentTop - before.offsetFromContentTop),
      `repeated prepends moved the view: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`,
    ).toBeLessThan(TOLERANCE)
  })
})

test.describe('visibility semantics', () => {
  test('emits nothing for comments flown past by scrollToKey', async ({ page }) => {
    await page.goto('/')
    await ready(page)

    const seenBefore = await page.evaluate(
      () => (window as unknown as { __list: { seenCount: () => number } }).__list.seenCount(),
    )

    // Fly across thousands of comments. None of them were read.
    await scrollToComment(page, 9000, { align: 'start' })
    await page.waitForTimeout(200)

    const seenAfter = await page.evaluate(
      () => (window as unknown as { __list: { seenCount: () => number } }).__list.seenCount(),
    )

    // Only what is resting on screen afterwards may be counted, not the journey.
    expect(seenAfter - seenBefore).toBeLessThan(12)
  })

  test('does not double-count under StrictMode', async ({ page }) => {
    await page.goto('/')
    // The demo runs in StrictMode, whose double mount re-fires anything derived
    // from effects. The tracker's state lives outside React for this reason.
    await expect(page.locator('.panel ol li').first()).toBeVisible({ timeout: 15_000 })

    const duplicates = await page.evaluate(() => {
      const entries = [...document.querySelectorAll('.panel ol li')].map(
        (li) => li.textContent,
      )
      const enters = entries.filter((text) => text.startsWith('enter'))
      return enters.length - new Set(enters).size
    })
    expect(duplicates).toBe(0)
  })
})

test.describe('accessibility', () => {
  test('walks focus between comments with the page keys', async ({ page }) => {
    await page.goto('/')
    await ready(page)

    await page.locator('[role="article"]').first().focus()
    const first = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset.virtualKey,
    )

    await page.keyboard.press('PageDown')
    await page.waitForTimeout(300)
    const second = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset.virtualKey,
    )

    expect(second).not.toBe(first)
    expect(second).toBeTruthy()
  })

  test('keeps focus when its comment scrolls out of the rendered range', async ({ page }) => {
    await page.goto('/')
    await ready(page)

    await page.locator('[role="article"]').first().focus()
    const focusedKey = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset.virtualKey,
    )

    await page.locator('.scroller').evaluate((el) => {
      el.scrollTop += 20_000
    })
    await page.waitForTimeout(300)

    // Focus survives, rather than falling back to <body>.
    const stillFocused = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset.virtualKey,
    )
    expect(stillFocused).toBe(focusedKey)
  })
})
