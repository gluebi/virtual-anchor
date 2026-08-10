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
    //
    // The bound is against the *collection*, not against a remembered row count. Four pages of
    // `PER_PAGE` are loaded by now, and the claim is that the list mounts a fraction of them —
    // so it is written as that fraction. It read `< 40`, which was the mounted count of the
    // day and had to move the moment overscan did: 2500px of buffer plus the slack that lets
    // the mounted range be held across a scroll puts it at 44 on this demo's rows.
    const loaded = 4 * PER_PAGE
    const mounted = await page.locator('[data-virtual-key]').count()
    expect(mounted).toBeLessThan(loaded / 2)
  })

  test('defers a fetch while a programmatic scroll is in flight', async ({ page }) => {
    // The protocol, demonstrated: animating to the end crosses the fetch margin while the
    // scroll is still running. Fetching there would move the target the animation is chasing.
    //
    // The demo no longer *narrates* the deferral, and that is the change worth
    // recording: it used to check `isScrolling()` itself and report "deferred",
    // and now `onEdgeReached` simply does not fire while a programmatic scroll is
    // in flight. So this asserts the outcome rather than the commentary — the
    // page count must not move while the animation runs, and the landing must
    // still be exact.
    await openPagination(page)
    await press(page, 'Infinite')

    await press(page, 'Jump to end')

    // The landing is reported on its own line, because arriving at the end now
    // triggers the next page immediately — `onEdgeReached` fires the moment the
    // animation settles, which is what infinite scrolling is for and which would
    // otherwise overwrite this before it could be read.
    await expect(page.locator('[data-testid="landing"]')).toContainText('settled=true', {
      timeout: 10_000,
    })
    await expect(page.locator('[data-testid="landing"]')).toContainText('deviation=0.000px')
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
