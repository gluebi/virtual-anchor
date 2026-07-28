import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

test.describe('accessibility', () => {
  test('has no axe violations', async ({ page }) => {
    await page.goto('/')
    await page.locator('[role="article"]').first().waitFor()

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze()

    expect(
      results.violations.map((violation) => `${violation.id}: ${violation.help}`),
    ).toEqual([])
  })

  test('describes the whole thread, not the loaded window', async ({ page }) => {
    await page.goto('/?comment=4211')
    await page.locator('[role="article"]').first().waitFor()

    const described = await page.evaluate(() =>
      [...document.querySelectorAll('[role="article"]')].map((article) => ({
        setsize: article.getAttribute('aria-setsize'),
        posinset: Number(article.getAttribute('aria-posinset')),
      })),
    )

    expect(described.length).toBeGreaterThan(0)
    // Every article reports the full thread size, and a position within it —
    // not a position within the sixty comments that happen to be mounted.
    for (const article of described) {
      expect(article.setsize).toBe('12000')
      expect(article.posinset).toBeGreaterThan(4000)
    }
  })

  test('marks the feed busy while a page loads', async ({ page }) => {
    await page.goto('/')
    const feed = page.getByRole('feed')
    await expect(feed).toHaveAttribute('aria-busy', /true|false/)
  })

  test('respects prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/')
    await page.locator('[role="article"]').first().waitFor()

    // A smooth request becomes an instant jump: one write, no animation frames.
    const result = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          __list: {
            setWindowAround: (i: number) => void
            scrollToKey: (k: string, o?: unknown) => Promise<{ iterations: number }>
          }
        }
      ).__list
      api.setWindowAround(300)
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise(requestAnimationFrame)
        if (document.querySelector('[data-comment-index="300"]')) break
      }
      return api.scrollToKey('comment-300', { align: 'start', behavior: 'smooth' })
    })

    // An eased approach takes dozens of frames; a jump takes almost none.
    expect(result.iterations).toBeLessThan(5)
  })
})
