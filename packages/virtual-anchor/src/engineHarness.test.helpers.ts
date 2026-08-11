/**
 * The parts of an engine harness that are about the platform rather than the suite.
 *
 * `engine.dom.test.ts` and `engine.ios.dom.test.ts` each build a harness, and most of
 * what they build genuinely differs — how they instrument reads, what they fake versus
 * delegate, how many rows they default to. None of that belongs here.
 *
 * What does belong here is what the two had converged on byte-for-byte: the observers,
 * the `Surface` fake, and the rules a scroller applies to a scroll write. Those are
 * statements about the browser, and a copy each is a standing invitation for the two
 * suites to disagree about one — the same argument `iosPlatform.test.helpers.ts` makes
 * for the platform sniff, where three copies meant a signal could be added to one while
 * the others silently carried on testing something else, passing and worthless.
 *
 * Not hypothetical on either count. Adding `Surface.setTrailingSpace` needed the same
 * four edits made twice, and `FakeResizeObserver` had *already* drifted: the DOM copy
 * grew an `inlineSize` parameter — the axis that reflows text, and the whole of #34 —
 * while the iOS copy still hardcoded it to zero.
 *
 * Named `.test.helpers.ts` for the reason `iosPlatform.test.helpers.ts` records: it
 * keeps the module out of both vitest `include` globs and out of the coverage one.
 */
import type { Surface } from './surface.js'
import type { ItemKey } from './types.js'

/** A fake ResizeObserver whose deliveries the test drives. */
export class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly observed = new Set<Element>()

  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.observed.add(target)
  }
  unobserve(target: Element): void {
    this.observed.delete(target)
  }
  disconnect(): void {
    this.observed.clear()
  }

  /**
   * `inlineSize` defaults to zero, but is a parameter rather than a constant.
   *
   * A width-only resize is a real delivery with real consequences — it is what decides
   * where text wraps, so it invalidates every measured row height (#34) — and a fake
   * that could not express one could not test the handling of one.
   */
  static deliverTo(target: Element, blockSize: number, inlineSize = 0): void {
    for (const instance of FakeResizeObserver.instances) {
      if (!instance.observed.has(target)) continue
      instance.callback(
        [
          {
            target,
            borderBoxSize: [{ blockSize, inlineSize }],
            contentRect: new DOMRect(0, 0, inlineSize, blockSize),
          },
        ] as unknown as ResizeObserverEntry[],
        instance,
      )
    }
  }
}

export class FakeIntersectionObserver implements IntersectionObserver {
  readonly scrollMargin = '0px'
  readonly root = null
  readonly rootMargin = '0px'
  readonly thresholds = [0]
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

/**
 * Put both fakes on `window` and forget any observer from a previous test.
 *
 * For a `beforeEach`. The instance list is static, so without the reset a delivery would
 * reach observers belonging to engines the last test already tore down.
 */
export function installObservers(): void {
  FakeResizeObserver.instances = []
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: FakeResizeObserver,
  })
  Object.defineProperty(window, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: FakeIntersectionObserver,
  })
}

/**
 * Everything both harnesses track about the scroller they are pretending to be.
 *
 * One object rather than loose variables because {@link maxOffsetFor} needs four of
 * these fields at once, and a signature taking four numbers is a place to transpose two.
 */
export interface HarnessState {
  offset: number
  viewportSize: number
  contentWidth: number
  contentSize: number
  leadingSpace: number
  trailingSpace: number
}

/** A fresh state, with the 800×600 geometry both suites are written against. */
export function harnessState(): HarnessState {
  return {
    offset: 0,
    viewportSize: 800,
    contentWidth: 600,
    contentSize: 0,
    leadingSpace: 0,
    trailingSpace: 0,
  }
}

/**
 * The {@link Surface} both harnesses fake: records every write, draws nothing.
 *
 * Each write is pushed as `<prefix>:<value>`, which is the vocabulary the assertions are
 * written against — `content:`, `lead:`, `trail:`, `paint:`, and `item:<key>@<offset>`.
 * The viewport fakes push `scroll:` into the same array, so a case can assert the
 * *ordering* between a style write and a scroll write, which is a real invariant: the
 * content size must grow before an offset is written, or the browser clamps it.
 *
 * `state`, `writes` and `elements` are the caller's, not this function's: both harnesses
 * reach into all three afterwards — to resize the scrollport, to assert, and to deliver a
 * measurement to an attached row.
 */
export function recordingSurface(
  state: HarnessState,
  writes: string[],
  elements: Map<ItemKey, HTMLElement>,
): Surface {
  return {
    setContentSize: (size) => {
      state.contentSize = size
      writes.push(`content:${String(size)}`)
    },
    setLeadingSpace: (px) => {
      state.leadingSpace = px
      writes.push(`lead:${String(px)}`)
    },
    setTrailingSpace: (px) => {
      state.trailingSpace = px
      writes.push(`trail:${String(px)}`)
    },
    setPaintOffset: (px) => writes.push(`paint:${String(px)}`),
    setItemOffset: (key, offset) => writes.push(`item:${String(key)}@${String(offset)}`),
    attachItem: (key, element) => {
      elements.set(key, element)
      return () => elements.delete(key)
    },
    hasItem: (key) => elements.has(key),
    focusItem: (key) => elements.has(key),
    dispose: () => {
      elements.clear()
    },
  }
}

/**
 * The furthest a scroller holding this much content would let you scroll.
 *
 * Everything the library writes into the scroller counts, and the sum is faithful only
 * because of *how* it writes them: the sizer's height, the leading space as a
 * `margin-top` above it, and the trailing space as a `padding-bottom` on a container
 * forced to `content-box`. All three add to the scroller's extent. A surface that
 * realised space some other way would need this to follow it.
 *
 * Floored at zero, as a browser floors it — content shorter than the scrollport has no
 * scroll range at all, which is the state both the sticky-footer and `alignToBottom`
 * cases live in.
 */
export function maxOffsetFor(state: HarnessState): number {
  return Math.max(
    0,
    state.contentSize + state.leadingSpace + state.trailingSpace - state.viewportSize,
  )
}

/**
 * What the scroller does with a written offset, before anyone reads it back.
 *
 * Two rules, and the order between them is the point. **Truncate, then clamp**: WebKit
 * takes the integer part of a fractional `scrollTop`, and the bound applies to what it
 * kept — reversing the two puts the accepted offset a pixel out at the very end of a
 * list, which is exactly where the landing tests measure. Both suites need to agree on
 * that ordering, and the previous arrangement asked each of them to spell it out and a
 * comment to ask the next editor not to let them diverge.
 *
 * `trackContent` off leaves the write unclamped, which is what a suite wants when it is
 * not testing the end of the list; see each harness's own note on the option.
 */
export function acceptedScrollOffset(
  state: HarnessState,
  next: number,
  options: { trackContent: boolean; truncateWrites: boolean },
): number {
  const accepted = options.truncateWrites ? Math.trunc(next) : next
  if (!options.trackContent) return accepted
  return Math.min(Math.max(accepted, 0), maxOffsetFor(state))
}
