import { expect, test, type Page } from '@playwright/test'
import { open, settle } from './helpers.js'

/**
 * The case `stableScrollbarGutter` exists for, which no other spec here can reach.
 *
 * Every other mode of the demo opens on forty comments or on the whole thread, so the scroller
 * has had a scrollbar since before its first measurement — and a scrollbar that was always there
 * cannot appear. `?loaded=2` opens on a list too short to scroll, which makes the transition into
 * overflowing something a test can stand on either side of.
 *
 * What the transition does, when the gutter is not reserved, is change the width the scrollport
 * lays text out at. That is not a cosmetic detail to this library: `layoutSignatureFor` hashes
 * exactly that width, and a changed signature makes the engine `clearAll()` — every height
 * measured before the scrollbar appeared is discarded, correctly, and the rows already outside
 * the mounted window are never re-measured. They keep their estimate for good.
 *
 * So the signature is what these assert on rather than a landing: it is the library's own answer
 * to "is everything I measured still valid", read straight out of a size snapshot, and it is the
 * step between a scrollbar appearing and a list quietly going wrong. A landing would be the more
 * satisfying assertion and is the wrong one — the convergence loop re-measures as it goes, so it
 * lands correctly even on stranded estimates. It takes longer to get there and the scrollbar is
 * the wrong length meanwhile, neither of which a test should be asked to judge.
 *
 * **The two tests carry this claim together, and on a platform with overlay scrollbars neither
 * carries anything.** Overlay scrollbars take no space, so nothing changes when one appears and
 * `scrollbar-gutter` is specified to have no effect at all — the first test would then pass
 * because there was nothing to observe rather than because the gutter did its job. That is what
 * the second is for: it fails, loudly, if opting out *also* changes nothing, and skips with a
 * reason when the platform is the explanation. CI runs on Linux, where all three engines draw
 * classic scrollbars; on macOS the pair skips out and proves nothing, deliberately.
 */

const SCROLLPORT = '.scroller'

/** The width text wraps at, scrollbar excluded — what the layout signature is taken from. */
const scrollportWidth = (page: Page): Promise<number> =>
  page.evaluate((selector) => document.querySelector(selector)?.clientWidth ?? Number.NaN, SCROLLPORT)

const overflows = (page: Page): Promise<boolean> =>
  page.evaluate((selector) => {
    const element = document.querySelector(selector)
    return element !== null && element.scrollHeight > element.clientHeight
  }, SCROLLPORT)

/** The engine's own verdict on whether everything measured so far is still valid. */
const layoutSignature = (page: Page): Promise<string> =>
  page.evaluate(() => window.__list.takeSizeSnapshot()?.layoutSignature ?? '')

/** Post enough comments that a list which fits becomes one that does not. */
async function growPastTheFold(page: Page): Promise<void> {
  await page.evaluate(() => window.__list.insert('below', 40))
  await expect.poll(() => overflows(page)).toBe(true)
  await settle(page)
}

test.describe('a scrollbar appearing after the first measurements', () => {
  test('does not change the width they were taken at', async ({ page }) => {
    await open(page, 'loaded=2')

    // The precondition, asserted rather than assumed: if the thread's first two comments ever
    // grow enough to overflow on their own, this whole file stops testing anything and should
    // say so here rather than passing quietly.
    expect(await overflows(page)).toBe(false)
    const width = await scrollportWidth(page)
    const signature = await layoutSignature(page)
    expect(signature).not.toBe('')

    await growPastTheFold(page)

    expect(await scrollportWidth(page)).toBe(width)
    expect(await layoutSignature(page)).toBe(signature)
  })

  test('does change it once the gutter is opted out, which is what the default prevents', async ({
    page,
  }) => {
    await open(page, 'loaded=2&stableGutter=0')

    expect(await overflows(page)).toBe(false)
    const width = await scrollportWidth(page)
    const signature = await layoutSignature(page)

    await growPastTheFold(page)

    const grownWidth = await scrollportWidth(page)
    // Overlay scrollbars take no space at all, so on a platform that draws them there is
    // nothing for the gutter to reserve and nothing here to observe — `scrollbar-gutter` is
    // specified to have no effect on them either. Skipped rather than weakened, so this keeps
    // its teeth on the platforms where classic scrollbars are what a reader gets.
    test.skip(
      grownWidth === width,
      'this platform draws overlay scrollbars, which take no width',
    )

    expect(grownWidth).toBeLessThan(width)
    // And the consequence: the engine now considers every height measured before this moment
    // to have been taken against a different layout, so it throws all of them away.
    expect(await layoutSignature(page)).not.toBe(signature)
  })
})
