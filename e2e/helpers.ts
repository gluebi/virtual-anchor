import { expect, type Page } from '@playwright/test'
import type {
  Anchor,
  ItemKey,
  ScrollResult,
  SizeSnapshot,
  TraceEvent,
} from '../packages/virtual-anchor/src/index.js'
import type { GestureVerdict } from '../packages/virtual-anchor/src/debug/index.js'

/**
 * The harness every accuracy spec shares.
 *
 * It lived three times over — once per spec file — and the copies had already drifted:
 * two spellings of the landing measurement, two of the readiness wait, three declarations
 * of the demo's test handle. Since the measurement *is* the acceptance criterion, having
 * more than one of it means the suite can disagree with itself about whether the library
 * works.
 */

/** Half a CSS pixel: the promise `scrollToKey` makes. */
export const TOLERANCE = 0.5

/**
 * The sticky header's height, which is the top inset a landing has to respect.
 *
 * Measured, never assumed: the demo's header wraps onto more rows as the window narrows, so
 * `scrollPaddingStart` changes at runtime — and a suite with 64 written into it started
 * failing by 21.5px the moment the header needed two rows. Zero when there is no header,
 * which is what the `paddingStart=0` scenarios render.
 */
export function headerHeight(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelector('.header')?.getBoundingClientRect().height ?? 0,
  )
}

/**
 * The demo's test handle.
 *
 * Declared once, globally, so no spec needs a local cast. `import type` is erased before
 * the page ever sees this file, which is why these can be the library's own types rather
 * than hand-written copies of them.
 */
export interface DemoHandle {
  scrollToKey: (key: string, options?: unknown) => Promise<ScrollResult>
  setWindowAround: (index: number) => void
  /** Prepend a page; `force` ignores the defer-while-scrolling protocol on purpose. */
  loadOlder: (force?: boolean) => Promise<number>
  loadNewer: () => Promise<number>
  seenCount: () => number
  enterCount: (key: string) => number
  maxEnterCount: () => number
  getAnchor: () => Anchor | null
  takeSizeSnapshot: () => SizeSnapshot | null
  /** Resize the measured header slot. Returns the height asked for. */
  setHeaderHeight: (height: number) => number
  /** Post comments at either end of the loaded window. */
  insert: (where: 'above' | 'below', count: number) => Promise<void>
  /** Whether the library currently considers the view to be at the end. */
  isAtBottom: () => boolean
}

declare global {
  interface Window {
    __list: DemoHandle
    /**
     * Count of `scrollTop` writes to the scrollport, when a spec has installed the
     * counting accessor. Declared here for the same reason `__list` is: so no spec
     * needs a local cast, and so the write and the read cannot disagree about the type.
     */
    __scrollWrites?: number
    /**
     * The demo's trace ring, present under `?trace=1` or `?debug=1`.
     *
     * Filtered by topic *prefix*, so `__trace('scroll.')` is every scroll topic. The library's own
     * types are used rather than hand-written copies for the same reason `DemoHandle` uses them:
     * `import type` is erased before the page ever sees this file, so a payload field that moves
     * breaks the spec at compile time instead of silently matching nothing.
     */
    __trace: (topic?: string) => TraceEvent[]
    __traceClear: () => void
    /** The most recent gesture's diagnosis, present under `?debug=1`. */
    __verdict: () => GestureVerdict | null
    __gestures: () => GestureVerdict[]
    __traceJSON: () => string
  }
}

/**
 * Where the demo persists a size snapshot.
 *
 * Duplicated from the demo's `config.ts` rather than imported, because that module reads
 * `window.location` at module scope and would throw in Playwright's Node context.
 */
export const SNAPSHOT_KEY = 'virtual-anchor-demo-sizes'

/**
 * Open the demo and wait until it is genuinely usable.
 *
 * Three separate races, all of which have bitten this suite:
 *
 *  - the handle is exposed from an effect that can run before the engine has any items,
 *    and `scrollToKey` on an empty list correctly resolves `{ reason: 'empty' }`;
 *  - articles must be mounted, not merely requested;
 *  - the demo deep-links on first paint, two frames in. That scroll has to finish before
 *    the suite drives its own, or the app's lands second and reports the suite's as
 *    `replaced` — correct behaviour, broken test.
 */
export async function open(page: Page, query = ''): Promise<void> {
  await page.goto(query === '' ? '/' : `/?${query}`)
  await page.waitForFunction(() => '__list' in window)
  await page.locator('[role="article"]').first().waitFor()
  await expect(page.locator('.panel .small').first()).toContainText('settled=', {
    timeout: 15_000,
  })
}

/**
 * Open the pagination demo.
 *
 * A separate opener because its readiness signal is different: that page has no deep-link to
 * settle, so waiting for `settled=` in the panel would wait forever.
 */
export async function openPagination(page: Page): Promise<void> {
  await page.goto('/pagination.html')
  await page.locator('[role="article"]').first().waitFor()
}

export interface ScrollOptions {
  align?: 'start' | 'center' | 'end'
  behavior?: 'auto' | 'smooth'
}

/** Drive `scrollToKey` for a comment index. */
export function scrollTo(
  page: Page,
  index: number,
  options: ScrollOptions = {},
): Promise<ScrollResult> {
  return page.evaluate(
    ({ index: i, options: opts }) => window.__list.scrollToKey(`comment-${String(i)}`, opts),
    { index, options },
  )
}

/**
 * Move the demo's loaded window around a comment and wait for it to arrive.
 *
 * For the paged regime, where only a 40-comment window is loaded. React flushes state
 * updates that originate outside itself asynchronously, so one frame is not enough —
 * scrolling too early resolves `unknown-key`.
 */
export function setWindowAround(page: Page, index: number): Promise<void> {
  return page.evaluate(async (i) => {
    window.__list.setWindowAround(i)
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise(requestAnimationFrame)
      if (document.querySelector(`[data-comment-index="${String(i)}"]`)) break
    }
  }, index)
}

/**
 * Wait two animation frames: one for React to commit, one for the corrective
 * write that commit provokes to land.
 *
 * Here rather than in each spec because the depth is a shared assumption about
 * the library's timing — how many frames a geometry change needs before the view
 * has settled. It had been written out three times in new code alone, twice with
 * the same comment attached, which is exactly the drift this module exists to
 * prevent.
 */
export function settle(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve()
          })
        })
      }),
  )
}

/**
 * How far the scroller is from its own maximum.
 *
 * The e2e mirror of `getMaxScrollOffset`, and the predicate the whole
 * `followOutput` suite asserts on — so it stays one definition.
 */
export function distanceFromBottom(page: Page): Promise<number> {
  return page
    .locator('.scroller')
    .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)
}

/** Where a row's top edge is, relative to the scrollport's content top. */
export function topOfKey(page: Page, key: ItemKey): Promise<number> {
  return page.evaluate((k) => {
    const row = document.querySelector(`[data-virtual-key="${k}"]`)
    const scroller = document.querySelector('.scroller')
    if (!row || !scroller) return Number.NaN
    return (
      row.getBoundingClientRect().top -
      (scroller.getBoundingClientRect().top + scroller.clientTop)
    )
  }, key)
}

export interface View {
  /** Height of chrome overlapping the top, which a target must land below. */
  paddingStart: number
  /** Height of chrome overlapping the bottom — a sticky footer slot. */
  paddingEnd?: number
  windowScroller?: boolean
}

/**
 * Sample offsets inside the `paddingStart` band that the header does *not* cover.
 *
 * The assertion `measure` cannot make. It computes the expected landing as
 * `view.top + paddingStart` and is therefore satisfied by any header height at all,
 * including one covering nothing — which is exactly what the demo shipped: the header was a
 * flex sibling above the scroller, so every `align: 'start'` target sat a header-height down
 * the scrollport with the *previous* comment visible above it, and the whole matrix reported
 * zero error. Reading the band closes that, because it is the one claim a fictional inset
 * cannot satisfy. See #104.
 */
export function uncoveredTopBand(page: Page, view: View): Promise<number[]> {
  return page.evaluate(
    ({ paddingStart, windowScroller }) => {
      const scroller = document.querySelector('.scroller')
      if (!scroller) return []
      const box = scroller.getBoundingClientRect()
      const top = windowScroller ? 0 : box.top + scroller.clientTop
      const x = box.left + box.width / 2

      const uncovered: number[] = []
      // Inset by a pixel at each end: the exact edges belong to whichever box rounds the
      // other way, and that is not what this is asking about.
      for (let dy = 1; dy < paddingStart - 1; dy += 8) {
        const el = document.elementFromPoint(x, top + dy)
        if (!el?.closest('.header')) uncovered.push(dy)
      }
      return uncovered
    },
    { paddingStart: view.paddingStart, windowScroller: view.windowScroller === true },
  )
}

export interface Landing {
  found: boolean
  /** Signed px between where the item is and where the alignment asked for. */
  error: number
  /**
   * Whether the requested position was unreachable.
   *
   * At either extreme, or for an item taller than the visible area, sitting at the
   * boundary is the scroller obeying the browser rather than an accuracy failure — the
   * first comment cannot sit below a sticky header with nothing above it to scroll away.
   */
  clamped: boolean
}

/**
 * Measure where a comment landed, for any alignment and either scroller kind.
 *
 * Against the scrollport's *content* top, which means adding `clientTop`:
 * `getBoundingClientRect().top` is the border-box top, and forgetting that reads a 1px
 * border as a 1px accuracy failure. This bit the residual-carry spike on its first run.
 */
export function measure(
  page: Page,
  index: number,
  align: 'start' | 'center' | 'end',
  view: View,
): Promise<Landing> {
  return page.evaluate(
    ({ index: i, align: alignment, paddingStart, paddingEnd, windowScroller }) => {
      const miss = { found: false, error: Number.NaN, clamped: false }
      const item = document
        .querySelector(`[data-comment-index="${String(i)}"]`)
        ?.closest('[role="article"]')
      if (!item) return miss

      // One view descriptor for both scroller kinds, so the arithmetic below — and the
      // clamp test in particular — exists once rather than per branch.
      // Typed, because the scrollbar allowance below reads `offsetHeight`, which is
      // an `HTMLElement` property. Untyped this compiled only because nothing ever
      // ran `tsc` over `e2e/` — see the root `typecheck` script.
      const scroller = document.querySelector<HTMLElement>('.scroller')
      if (!scroller) return miss
      const box = scroller.getBoundingClientRect()
      const view = windowScroller
        ? {
            top: 0,
            height: window.innerHeight,
            scrollOffset: window.scrollY,
            max: document.documentElement.scrollHeight - window.innerHeight,
          }
        : {
            top: box.top + scroller.clientTop,
            // The exact content height, not `clientHeight` — that is an integer, and
            // comparing an exact landing against a rounded expectation reads as a bug in
            // whichever of the two happens to round the other way.
            height: box.height - (scroller.offsetHeight - scroller.clientHeight),
            scrollOffset: scroller.scrollTop,
            max: scroller.scrollHeight - scroller.clientHeight,
          }

      const rect = item.getBoundingClientRect()
      const visibleTop = view.top + paddingStart
      const visibleBottom = view.top + view.height - paddingEnd
      const visibleSize = visibleBottom - visibleTop

      const expected =
        alignment === 'start'
          ? visibleTop
          : alignment === 'end'
            ? visibleBottom - rect.height
            : visibleTop + (visibleSize - rect.height) / 2

      return {
        found: true,
        error: rect.top - expected,
        clamped:
          view.scrollOffset <= 0.5 ||
          view.scrollOffset >= view.max - 0.5 ||
          rect.height > visibleSize,
      }
    },
    {
      index,
      align,
      paddingStart: view.paddingStart,
      paddingEnd: view.paddingEnd ?? 0,
      windowScroller: view.windowScroller === true,
    },
  )
}

/**
 * Where every row a reader can see currently sits, keyed by item key.
 *
 * For the assertions about *not* moving: a prepend or an append is only correct if every row
 * that was on screen is still exactly where it was. Rows hidden behind the sticky header are
 * excluded — they are on screen only in the arithmetic sense.
 */
export function visibleRowTops(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const scroller = document.querySelector('.scroller')
    if (!scroller) return {}

    const box = scroller.getBoundingClientRect()
    const visibleTop = box.top + (document.querySelector('.header')?.getBoundingClientRect().height ?? 0)
    return Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>('[data-virtual-key]')]
        .filter((row) => {
          const rect = row.getBoundingClientRect()
          return rect.bottom > visibleTop && rect.top < box.bottom
        })
        .map((row) => [row.dataset.virtualKey ?? '', row.getBoundingClientRect().top - box.top]),
    )
  })
}

/**
 * The largest distance any row present in both snapshots moved.
 *
 * `null` when they share no rows, which means the view changed entirely — a different failure
 * from "something shifted", and one an assertion should not silently pass.
 */
export function worstMovement(
  before: Record<string, number>,
  after: Record<string, number>,
): number | null {
  const shared = Object.keys(before).filter((key) => key in after)
  if (shared.length === 0) return null
  return Math.max(...shared.map((key) => Math.abs((after[key] ?? 0) - (before[key] ?? 0))))
}
