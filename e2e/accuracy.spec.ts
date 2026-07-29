import { expect, test } from '@playwright/test'
import {
  headerHeight,
  measure,
  open,
  scrollTo,
  setWindowAround,
  TOLERANCE,
  topOfKey,
} from './helpers.js'

/**
 * Behaviour that only shows up in a *paged* list — one whose window grows as you read.
 *
 * The per-alignment landing accuracy lives in `matrix.spec.ts`, which runs the same
 * assertions across every combination of scroll padding, scroll margin, scroller kind and
 * loaded-window size, including a paged one. What is here instead is what a matrix of
 * static configurations cannot express: a view that must not move while the collection
 * changes underneath it, a deep link with nothing measured yet, and the boundaries.
 */

/** The comment every prepend test watches. */
const watched = 'comment-4211'

test.describe('a deep link with nothing measured', () => {
  test('lands from a cold start', async ({ page }) => {
    // No prior scrolling, so every size is an estimate and the first aim is a guess. The
    // convergence loop is the whole reason this can still be exact.
    await open(page, 'comment=8642')

    const landing = await measure(page, 8642, 'start', { paddingStart: await headerHeight(page) })
    expect(landing.found).toBe(true)
    // Not merely in view — at the requested offset.
    expect(Math.abs(landing.error)).toBeLessThan(TOLERANCE)
  })

  test('sits exactly at the boundary for the first and last comments', async ({ page }) => {
    await open(page)

    for (const [index, edge] of [
      [0, 'top'],
      [11_999, 'bottom'],
    ] as const) {
      await setWindowAround(page, index)
      await scrollTo(page, index, { align: edge === 'top' ? 'start' : 'end' })

      const position = await page.locator('.scroller').evaluate((el) => ({
        scrollTop: el.scrollTop,
        max: el.scrollHeight - el.clientHeight,
      }))

      if (edge === 'top') expect(position.scrollTop).toBeLessThanOrEqual(TOLERANCE)
      else expect(position.max - position.scrollTop).toBeLessThanOrEqual(TOLERANCE)
    }
  })
})

test.describe('prepend and append do not move the view', () => {
  test('holds position when older comments load at the top', async ({ page }) => {
    await open(page, 'comment=4211')
    const before = await topOfKey(page, watched)

    const grew = await page.evaluate(() => window.__list.loadOlder())
    expect(grew).toBeGreaterThan(0)

    const after = await topOfKey(page, watched)
    expect(
      Math.abs(after - before),
      `prepend moved the view from ${String(before)} to ${String(after)}`,
    ).toBeLessThan(TOLERANCE)
  })

  test('holds position when newer comments load at the bottom', async ({ page }) => {
    await open(page, 'comment=4211')
    const before = await topOfKey(page, watched)

    await page.evaluate(() => window.__list.loadNewer())

    const after = await topOfKey(page, watched)
    expect(
      Math.abs(after - before),
      `append moved the view from ${String(before)} to ${String(after)}`,
    ).toBeLessThan(TOLERANCE)
  })

  test('holds position through repeated prepends', async ({ page }) => {
    await open(page, 'comment=4211')
    const before = await topOfKey(page, watched)

    for (let round = 0; round < 5; round++) {
      await page.evaluate(() => window.__list.loadOlder())
    }

    const after = await topOfKey(page, watched)
    // Five pages of unmeasured comments inserted above, and still not a pixel.
    expect(
      Math.abs(after - before),
      `repeated prepends moved the view from ${String(before)} to ${String(after)}`,
    ).toBeLessThan(TOLERANCE)
  })
})

test.describe('visibility semantics', () => {
  test('emits nothing for comments flown past by scrollToKey', async ({ page }) => {
    await open(page)
    const seenBefore = await page.evaluate(() => window.__list.seenCount())

    // Fly across thousands of comments. None of them were read.
    await setWindowAround(page, 9000)
    await scrollTo(page, 9000, { align: 'start' })
    await page.waitForTimeout(200)

    const seenAfter = await page.evaluate(() => window.__list.seenCount())
    // Only what is resting on screen afterwards may be counted, not the journey.
    expect(seenAfter - seenBefore).toBeLessThan(12)
  })

  test('does not double-count under StrictMode', async ({ page }) => {
    // The demo runs in StrictMode, whose double mount re-fires anything derived from
    // effects. The tracker's state lives outside React for this reason.
    await open(page)

    // Scroll rather than waiting out the dwell at rest. Same events either way, but the
    // idle path depends on a 600ms timer completing while every other worker in the suite
    // competes for the CPU, which made this assertion fail about one run in three.
    await page.locator('.scroller').evaluate((el) => {
      el.scrollTop += 400
    })
    await expect(page.locator('.panel ol li').first()).toBeVisible({ timeout: 15_000 })

    const duplicates = await page.evaluate(() => {
      const entries = [...document.querySelectorAll('.panel ol li')].map((li) => li.textContent)
      const enters = entries.filter((text) => text.startsWith('enter'))
      return enters.length - new Set(enters).size
    })
    expect(duplicates).toBe(0)
  })
})

test.describe('accessibility', () => {
  test('walks focus between comments with the page keys', async ({ page }) => {
    await open(page)

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
    await open(page)

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
