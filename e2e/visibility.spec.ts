import { expect, test, type Page } from '@playwright/test'
import { open } from './helpers.js'

/**
 * The trailing-edge visibility rule, against real layout.
 *
 * The unit tests pin the arithmetic; what they cannot do is prove it against heights a browser
 * actually produced. This spec exists for the one case no other rule can express: a comment
 * several times the height of the viewport, which must not count as read while the reader is
 * still in the middle of it.
 */

/**
 * A comment the thread generator gives 14 paragraphs.
 *
 * `buildThread` keys paragraph count off `(index * 37) % 100`, and 14 paragraphs needs that at
 * 97 or above — which is indices ending in 27, 54 or 81. Deterministic, so this is a fact about
 * the fixture rather than a guess.
 */
const TALL = 1081

/** Height of the tall comment, and of the area a reader can actually see. */
async function geometry(page: Page) {
  return page.evaluate((index) => {
    const article = document
      .querySelector(`[data-comment-index="${String(index)}"]`)
      ?.closest('[role="article"]')
    const scroller = document.querySelector('.scroller')
    if (!article || !scroller) return null

    const header = document.querySelector('.header')?.getBoundingClientRect().height ?? 0
    return {
      item: article.getBoundingClientRect().height,
      visible: scroller.clientHeight - header,
    }
  }, TALL)
}

test.describe('the trailing-edge visibility rule', () => {
  /**
   * A short window, because the fixture's longest comment is only ~800px.
   *
   * At the default 720px the viewport contains most of it, which makes this the *ordinary* case
   * and the spec vacuous — the fraction rule reported it happily at 75% of itself showing.
   * Shortening the window is how "taller than the viewport" becomes true of a fixture whose
   * heights are fixed. The width stays wide on purpose: narrowing it wraps the demo's sticky
   * header onto three rows, and a `scrollPaddingStart` taller than the scrollport leaves a
   * negative visible band, where nothing can satisfy any rule.
   */
  test.use({ viewport: { width: 1280, height: 600 } })

  /** No sticky header, so the visible band is the whole scrollport and the arithmetic is plain. */
  const QUERY = `rule=edge&comment=${String(TALL)}&loadAll=1&paddingStart=0`

  test('reports a comment taller than the viewport only once its bottom edge arrives', async ({
    page,
  }) => {
    await open(page, QUERY)

    // Without this the rest proves nothing: the whole point is an item the viewport cannot
    // contain, and a fixture change that shortened it would silently turn this into a test of
    // the ordinary case.
    const size = await geometry(page)
    expect(size).not.toBeNull()
    expect(
      size?.item ?? 0,
      'the fixture comment is no longer taller than the viewport',
    ).toBeGreaterThan(size?.visible ?? 0)

    // Parked at its top: the reader is at the beginning of a very long comment. Its leading
    // edge is on screen and several screens of its body are too, which is exactly what a
    // fraction rule cannot tell apart from having finished it.
    await page.evaluate(async (index) => {
      await window.__list.scrollToKey(`comment-${String(index)}`, { align: 'start' })
    }, TALL)
    // Comfortably past the demo's 600ms dwell, so a rule that was going to fire has fired.
    await page.waitForTimeout(900)

    expect(
      await page.evaluate((index) => window.__list.enterCount(`comment-${String(index)}`), TALL),
      'reported as read while the reader was still in the middle of it',
    ).toBe(0)

    // Now to its end.
    await page.evaluate(async (index) => {
      await window.__list.scrollToKey(`comment-${String(index)}`, { align: 'end' })
    }, TALL)
    await page.waitForTimeout(900)

    expect(
      await page.evaluate((index) => window.__list.enterCount(`comment-${String(index)}`), TALL),
      'never reported, even with its trailing edge on screen',
    ).toBeGreaterThan(0)
  })

  test('is reported early by the item-fraction rule, which is the drift it fixes', async ({
    page,
  }) => {
    // The control. Parked at the comment's *top*, three quarters of it happens to be on screen,
    // so a 50%-of-the-item rule calls it read before the reader has seen its second half — the
    // failure the assertion above pins down from the other side. Without this, that assertion
    // could be passing for some reason other than the rule it is testing.
    await open(page, QUERY.replace('rule=edge&', ''))

    await page.evaluate(async (index) => {
      await window.__list.scrollToKey(`comment-${String(index)}`, { align: 'start' })
    }, TALL)
    await page.waitForTimeout(900)

    const size = await geometry(page)
    // The premise, asserted rather than assumed: this only demonstrates drift while half the
    // item genuinely fits.
    expect((size?.visible ?? 0) / (size?.item ?? 1)).toBeGreaterThan(0.5)

    expect(
      await page.evaluate((index) => window.__list.enterCount(`comment-${String(index)}`), TALL),
    ).toBeGreaterThan(0)
  })
})
