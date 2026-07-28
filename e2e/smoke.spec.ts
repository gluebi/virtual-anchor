import { expect, test } from '@playwright/test'

/**
 * First end-to-end check that the assembled library actually works in a browser.
 *
 * The accuracy matrix lives in `accuracy.spec.ts`; this file only answers "does
 * it render, scroll, deep-link and report visibility at all".
 */
test.describe('demo smoke', () => {
  test('renders a windowed thread rather than every comment', async ({ page }) => {
    await page.goto('/')
    const feed = page.getByRole('feed')
    await expect(feed).toBeVisible()

    const articles = page.locator('[role="article"]')
    await expect(articles.first()).toBeVisible()

    // A window of a 12,000-comment thread, not the whole thing.
    const mounted = await articles.count()
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(60)
  })

  test('reports the full thread size to assistive technology', async ({ page }) => {
    await page.goto('/')
    const first = page.locator('[role="article"]').first()
    await expect(first).toHaveAttribute('aria-setsize', '12000')
    await expect(first).toHaveAttribute('aria-posinset', /\d+/)
  })

  test('deep-links to a comment and reports how it settled', async ({ page }) => {
    await page.goto('/?comment=4211')

    const status = page.locator('.panel .small').first()
    await expect(status).toContainText('settled=true', { timeout: 15_000 })

    // The requested comment is mounted and on screen.
    await expect(page.locator('[data-comment-index="4211"]')).toBeVisible()
  })

  test('scrolls without blanking out', async ({ page }) => {
    await page.goto('/')
    const scroller = page.locator('.scroller')

    for (let i = 0; i < 6; i++) {
      await scroller.evaluate((el) => {
        el.scrollTop += 1500
      })
      await page.waitForTimeout(80)
      await expect(page.locator('[role="article"]').first()).toBeVisible()
    }
  })

  test('emits per-item visibility events', async ({ page }) => {
    await page.goto('/')
    // The default rule needs 600ms of dwell at 50% coverage.
    await expect(page.locator('.panel ol li').first()).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.panel ol li').first()).toContainText('enter')
  })

  test('logs no ResizeObserver loop errors while scrolling', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })

    await page.goto('/')
    const scroller = page.locator('.scroller')
    for (let i = 0; i < 10; i++) {
      await scroller.evaluate((el) => {
        el.scrollTop += 2000
      })
      await page.waitForTimeout(50)
    }

    // A structural guarantee rather than an assumption: the total-height write
    // goes to a sibling of the observed items, never an ancestor.
    expect(errors.filter((e) => e.includes('ResizeObserver loop'))).toEqual([])
  })
})
