import { expect, test } from '@playwright/test'
import { fileURLToPath } from 'node:url'

/**
 * RISK GATE for the residual-carry technique.
 *
 * The plan's sub-pixel accuracy target rests on an idea no existing virtual list
 * uses: when the platform refuses to accept a fractional `scrollTop` (WebKit
 * truncates to integers; every engine snaps to physical pixels), carry the
 * leftover as a sub-pixel translate on the item container instead of re-writing
 * `scrollTop` to chase it.
 *
 * If this does not hold up, the <0.5px acceptance criterion has to be
 * renegotiated before the rest of the library is built on top of it.
 */
const page_url = `file://${fileURLToPath(new URL('./residual-carry.html', import.meta.url))}`

interface SpikeSummary {
  userAgent: string
  devicePixelRatio: number
  probes: number
  scrollTopIsFractional: boolean
  worstResidualSeen: number
  worstErrorNaive: number
  worstErrorWithCarry: number
  passesHalfPixelNaive: boolean
  passesHalfPixelWithCarry: boolean
}

test.describe('residual carry', () => {
  test('lands a fractional target within half a pixel', async ({ page }, testInfo) => {
    await page.goto(page_url)
    await expect(page.locator('#out')).not.toHaveText('running…')

    const summary = await page.evaluate(
      () => (window as unknown as { __spike: SpikeSummary }).__spike,
    )
    await testInfo.attach('spike-summary', {
      body: JSON.stringify(summary, null, 2),
      contentType: 'application/json',
    })
     
    console.log(`\n[${testInfo.project.name}]`, JSON.stringify(summary, null, 2))

    expect(summary.probes).toBeGreaterThan(15)
    expect(summary.worstErrorWithCarry).toBeLessThan(0.5)
  })
})
