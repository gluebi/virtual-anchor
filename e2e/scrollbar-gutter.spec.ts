import { expect, test, type Page } from '@playwright/test'
import { open } from './helpers.js'

/**
 * That the scrollport the component builds carries the gutter declaration, in a real browser.
 *
 * **Not** that reserving one keeps the width steady when a scrollbar appears. That was the first
 * version of this file and it cannot be written honestly, which is worth recording so nobody
 * spends the afternoon again. Measured on the three engines this suite runs, on macOS:
 *
 *  | engine   | `auto`, content starts overflowing | `stable`, before overflow |
 *  | -------- | ---------------------------------- | ------------------------- |
 *  | Chromium | width unchanged — overlay          | 15px reserved             |
 *  | WebKit   | width shrinks 15px                 | nothing reserved          |
 *  | Firefox  | width unchanged — overlay          | nothing reserved          |
 *
 * So Chromium cannot show the width changing, WebKit cannot show it being prevented, and Firefox
 * can do neither: every engine draws overlay scrollbars by default, which take no space and which
 * `scrollbar-gutter` is specified to have no effect on. Styling `::-webkit-scrollbar` forces the
 * classic kind in two of the three but not consistently enough to assert on, and Firefox has no
 * equivalent at all. A test written on top of that skips itself out of existence or passes because
 * there was nothing to observe — the first version did both, on CI as well as locally.
 *
 * What the *library* promises is narrower and is entirely testable: the declaration goes on the
 * scrollport it created, unless the consumer says otherwise, and never on a host element that is
 * not a scrollport. What the browser then does with it is the browser's business, and on a
 * platform with classic scrollbars — which is what most readers on Windows and Linux have — it is
 * the difference the changeset describes.
 *
 * `?loaded=2` opens on a list too short to scroll, which is the state the property exists to
 * survive being scrolled out of, and the one mode of the demo that can reach it.
 */

const gutterOf = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const element = document.querySelector('.scroller')
    return element === null ? 'no scrollport' : getComputedStyle(element).scrollbarGutter
  })

test.describe('the scrollport the component creates', () => {
  test('reserves the scrollbar gutter by default', async ({ page }) => {
    await open(page, 'loaded=2')
    expect(await gutterOf(page)).toBe('stable')
  })

  test('gives it up when the consumer opts out', async ({ page }) => {
    await open(page, 'loaded=2&stableGutter=0')
    expect(await gutterOf(page)).toBe('auto')
  })

  test('never writes it when the page is the scroller', async ({ page }) => {
    // There is no scrollport of ours in that mode, and whether the *document* reserves a gutter
    // is the host page's decision rather than a list's.
    await open(page, 'windowScroller=1')
    expect(await gutterOf(page)).toBe('auto')
  })
})
