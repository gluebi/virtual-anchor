import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { openPagination, visibleRowTops, worstMovement } from './helpers.js'

/**
 * The pagination demo, which covers the two collection changes the thread page does not.
 *
 * Paging *replaces* every key, so there is no position to preserve and the list has to land
 * at the top deterministically. Infinite scrolling *appends*, so nothing already on screen
 * may move — and the fetch has to skip itself while a programmatic scroll is in flight,
 * which is the only protocol this library asks a consumer to follow.
 */

const PER_PAGE = 50
const status = (page: Page): Promise<string> =>
  page.locator('[data-testid="status"]').innerText()

const press = (page: Page, label: string): Promise<void> =>
  page.getByRole('button', { name: label, exact: true }).click()

test.describe('page-at-a-time', () => {
  test('lands at the top of the new page', async ({ page }) => {
    await openPagination(page)

    // Read some way into page one, so "landed at the top" is a real claim.
    await page.locator('.scroller').evaluate((el) => {
      el.scrollTop = 2200
    })
    expect(await page.locator('.scroller').evaluate((el) => el.scrollTop)).toBeGreaterThan(2000)

    await press(page, 'Next ›')
    await expect(page.locator('[data-testid="status"]')).toContainText('landed at the top')

    expect(await status(page)).toContain('deviation=0.000px')
    expect(await page.locator('.scroller').evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(0.5)

    // And it is genuinely the next page's comments, not the same ones re-labelled.
    const first = await page
      .locator('[data-comment-index]')
      .first()
      .getAttribute('data-comment-index')
    expect(Number(first)).toBe(PER_PAGE)
  })

  test('announces a position in the thread, not in the page', async ({ page }) => {
    // A reader on page 3 is at comment 101 of 12,000. Reporting "1 of 50" would describe the
    // fetching strategy rather than the thread.
    await openPagination(page)
    await press(page, 'Next ›')
    await press(page, 'Next ›')
    await expect(page.locator('[data-testid="status"]')).toContainText('page 3')

    const described = await page.evaluate(() => {
      const article = document.querySelector('[role="article"]')
      return {
        setsize: article?.getAttribute('aria-setsize'),
        posinset: Number(article?.getAttribute('aria-posinset')),
      }
    })

    expect(described.setsize).toBe('12000')
    expect(described.posinset).toBe(2 * PER_PAGE + 1)
  })
})

test.describe('infinite scrolling', () => {
  test('appends without moving anything on screen', async ({ page }) => {
    await openPagination(page)
    await press(page, 'Infinite')
    await expect(page.locator('[data-testid="status"]')).toContainText('comments loaded')

    const before = await visibleRowTops(page)
    expect(Object.keys(before).length).toBeGreaterThan(2)

    await press(page, 'Load next page')
    await expect(page.locator('[data-testid="status"]')).toContainText('nothing moved')
    const after = await visibleRowTops(page)

    expect(
      worstMovement(before, after),
      'appending below the view moved something inside it',
    ).toBeLessThanOrEqual(0.5)
  })

  test('keeps appending as the end approaches', async ({ page }) => {
    await openPagination(page)
    await press(page, 'Infinite')

    for (let round = 0; round < 3; round++) {
      await page.locator('.scroller').evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await expect(page.locator('[data-testid="status"]')).toContainText(
        `${String((round + 2) * PER_PAGE)} comments loaded`,
        { timeout: 5000 },
      )
    }

    // Still a window, not the whole collection: appending must not mount everything.
    const mounted = await page.locator('[data-virtual-key]').count()
    expect(mounted).toBeLessThan(40)
  })

  test('defers a fetch while a programmatic scroll is in flight', async ({ page }) => {
    // The protocol, demonstrated: animating to the end crosses the fetch margin while the
    // scroll is still running. Fetching there would move the target the animation is chasing.
    await openPagination(page)
    await press(page, 'Infinite')

    await press(page, 'Jump to end')
    await expect(page.locator('[data-testid="status"]')).toContainText('deferred', {
      timeout: 5000,
    })

    // And the deferred-around scroll still lands exactly.
    await expect(page.locator('[data-testid="status"]')).toContainText('settled=true', {
      timeout: 10_000,
    })
    expect(await status(page)).toContain('deviation=0.000px')
  })
})

test.describe('accessibility', () => {
  test('has no axe violations in either mode', async ({ page }) => {
    await openPagination(page)

    for (const mode of ['Pages', 'Infinite'] as const) {
      await press(page, mode)
      await page.locator('[role="article"]').first().waitFor()

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze()

      expect(
        results.violations.map((violation) => `${mode} — ${violation.id}: ${violation.help}`),
      ).toEqual([])
    }
  })
})
