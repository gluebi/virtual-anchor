import { expect, test, type Page } from '@playwright/test'
import { open } from './helpers.js'

/**
 * The momentum write gate, in a real WebKit that believes it is an iPhone.
 *
 * **What this proves and what it does not.** The `mobile-webkit` project supplies an
 * iPhone user agent and `hasTouch`, so `isIOSWebKit()` returns true and the gate is
 * live — which means the wiring is exercised end to end in a real engine: the gate
 * shuts on `touchend`, no `scrollTop` write escapes before `scrollend`, and the
 * deferred correction lands afterwards.
 *
 * It does **not** prove the fling survives, because Playwright's synthesised touch
 * events produce no momentum for there to be a fling. That is only verifiable on real
 * hardware — the README says so, and it still says so. What automation can do is fail
 * if a write ever escapes the closed window, which is the defect (#26) rather than the
 * symptom.
 *
 * Counting is done by patching the `scrollTop` setter before any script runs, so it
 * catches a write from anywhere in the library rather than from the paths a test
 * thought to look at.
 */

/** Count every `scrollTop` write on the scrollport, from page load onwards. */
const countScrollWrites = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const proto = Element.prototype as unknown as Record<string, unknown>
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'scrollTop')
    if (!descriptor?.set || !descriptor.get) return
    // Bound through arrows so the accessor pair keeps its receiver when re-installed
    // below; a bare reference to a descriptor's method loses `this`.
    const original = (target: Element, value: number): void => {
      descriptor.set?.call(target, value)
    }
    const read = (target: Element): unknown => descriptor.get?.call(target)
    window.__scrollWrites = 0
    Object.defineProperty(proto, 'scrollTop', {
      configurable: true,
      get(this: Element) {
        return read(this)
      },
      set(this: Element, value: number) {
        if ((this as HTMLElement).classList.contains('scroller')) {
          window.__scrollWrites = (window.__scrollWrites ?? 0) + 1
        }
        original(this, value)
      },
    })
  })
}

const writes = (page: Page): Promise<number> =>
  page.evaluate(() => window.__scrollWrites ?? 0)

/**
 * Put a finger down and leave it there.
 *
 * A DOM event rather than `page.touchscreen`, which also lifts the finger and so starts
 * the grace period that correctly reopens the gate — a tap is not a fling. Holding
 * `touching` needs no timer, so there is no race to lose.
 */
const holdFinger = (page: Page): Promise<void> =>
  page.evaluate(() => {
    document.querySelector('.scroller')?.dispatchEvent(new Event('touchstart', { bubbles: true }))
  })

test.describe('the momentum write gate on an emulated iPhone', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'webkit' || !isMobile,
    'needs the mobile-webkit project, where isIOSWebKit() is true',
  )

  test('is live at all — the platform sniff matches', async ({ page }) => {
    // Guards the guard. If the descriptor ever stops matching, every assertion below
    // passes for the wrong reason, silently.
    await open(page, 'comment=4211')
    const active = await page.evaluate(
      () => /iP(hone|od|ad)/.test(navigator.userAgent) && 'ontouchend' in window,
    )
    expect(active).toBe(true)
  })

  test('lets no scrollTop write escape while a gesture is in flight', async ({ page }) => {
    await countScrollWrites(page)
    await open(page, 'comment=4211')

    await holdFinger(page)

    const baseline = await writes(page)

    // A style change that alters wrapping, so every mounted row re-measures at once —
    // the same event the library sees when a webfont lands. Scrolling alone is not
    // enough of a provocation: rows mounting *below* the anchor move nothing it
    // resolves against, so there is no correction to suppress and the assertion would
    // pass with the guard removed entirely.
    await page.addStyleTag({
      content: '.comment { letter-spacing: 0.45px; word-spacing: 1.5px; }',
    })

    // Long enough for the ResizeObserver deliveries and the measurement batch that
    // follows them. Every one of those used to write `scrollTop`.
    await page.waitForTimeout(600)

    expect(await writes(page)).toBe(baseline)
  })

  test('a prepend still writes, gesture or no gesture', async ({ page }) => {
    // The deliberate exception, and the reason the deferral is keyed on *cause*: a
    // model change deferred would move the reader by the whole inserted height.
    await countScrollWrites(page)
    await open(page, 'comment=4211')

    await holdFinger(page)
    const baseline = await writes(page)

    await page.evaluate(() => window.__list.insert('above', 20))
    await page.waitForTimeout(600)

    expect(await writes(page)).toBeGreaterThan(baseline)
  })

  test('still lands a deep link exactly, with the gate in the loop', async ({ page }) => {
    // The regression that matters most for consumers: the gate must not cost accuracy.
    await open(page, 'comment=6018')
    const readout = page.locator('.panel .small').first()
    await expect(readout).toContainText('settled=true', { timeout: 15_000 })
  })
})
