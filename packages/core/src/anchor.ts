import { ListGeometry, type ListInsets } from './listGeometry.js'
import type { SizeCache } from './sizeCache.js'
import type { Anchor } from './types.js'

/**
 * Alias of {@link ListInsets}, kept so the exported type name does not change.
 *
 * The concept was originally named after the anchor even though the anchor was only
 * one of its four consumers — which is exactly why the other three re-derived the
 * conversion instead of reusing it. New code should say `ListInsets`; this is not
 * marked `@deprecated` because that would warn at a dozen internal call sites for a
 * rename that costs a consumer nothing.
 */
export type AnchorGeometry = ListInsets

export const SELF_WRITE_TOLERANCE = 1.5

/**
 * Hard ceiling on the sub-pixel residual carry.
 *
 * The carry exists to recover the fraction of a pixel the browser refused to
 * take. If the difference is larger than a pixel then something else moved the
 * scroll — most likely the browser clamped the write against a `scrollHeight`
 * that has not grown yet — and carrying it would shove the visible content by
 * that whole amount. Refusing to carry is always the safe failure here: the
 * convergence loop simply re-aims on the next round.
 */
export const MAX_CARRY = 1

/**
 * Convert a scroll offset into a list-relative probe point.
 *
 * The probe is the pixel of list content sitting at the top of the *visible*
 * area — below any sticky header — which is the point the anchor is defined
 * against.
 */
function geometryOf(insets: ListInsets | undefined): ListGeometry {
  return new ListGeometry(insets ?? {})
}

/**
 * Capture the current viewport position as an anchor.
 *
 * Returns `null` only for an empty window, where there is nothing to anchor to.
 *
 * `offsetWithinItem` is deliberately allowed to fall outside the item's own box:
 * negative when the list start is still below the top of the scrollport, larger
 * than the item when the probe is past the end of a short list. Both are real
 * states and both must round-trip exactly, or scrolling to the extremes would
 * quietly lose the position.
 */
export function deriveAnchor(
  scrollTop: number,
  cache: SizeCache,
  geometry?: ListInsets,
): Anchor | null {
  const probe = geometryOf(geometry).toList(scrollTop)
  const item = cache.itemAt(probe)
  if (item === null) return null

  return { key: item.key, offsetWithinItem: probe - item.start }
}

/**
 * The scroll offset that puts an anchor back where it was.
 *
 * This is the exact inverse of {@link deriveAnchor}, and it is the function that
 * makes prepending free. New items above change the anchored item's *offset*,
 * so this returns a different number than last time — which is precisely what
 * keeps the same pixel of the same comment under the same row of the screen.
 *
 * Returns `null` when the anchored key is no longer in the window. Callers
 * decide what that means rather than being handed a silent 0: for a grows-only
 * window it cannot happen, and if it does, holding the current offset is far
 * better than jumping to the top.
 */
export function resolveAnchorOffset(
  anchor: Anchor,
  cache: SizeCache,
  geometry?: ListInsets,
): number | null {
  const index = cache.indexOf(anchor.key)
  if (index < 0) return null

  // The inverse conversion, via the same owner — previously spelled out here and
  // again in `offsetForIndex` eight lines below, so a change to the insets had two
  // edit sites.
  return offsetForIndex(index, cache, geometry) + anchor.offsetWithinItem
}

/**
 * The offset that puts `index`'s top edge at the top of the visible area.
 *
 * Same conversion as {@link resolveAnchorOffset}, by index rather than key, for
 * the scroller's alignment maths.
 */
export function offsetForIndex(
  index: number,
  cache: SizeCache,
  geometry?: ListInsets,
): number {
  return geometryOf(geometry).toScroll(cache.offsetOf(index))
}

/**
 * Whether an observed scroll offset is the echo of a write we just made.
 *
 * Without this, every corrective write looks like user input: the scroll
 * direction flips, velocity readings spike, and visibility events fire for a
 * scroll that never happened.
 */
export function isSelfWrite(observed: number, intended: number | null): boolean {
  if (intended === null) return false
  return Math.abs(observed - intended) <= SELF_WRITE_TOLERANCE
}

/**
 * The sub-pixel remainder to carry visually after a scroll write.
 *
 * Positive means the browser stopped short of where we wanted to be, so content
 * should shift *up* by this much — apply as `translateY(-carry)` on the item
 * container. See {@link MAX_CARRY} for why a large difference carries nothing.
 *
 * This is the piece of the design with no precedent in the existing libraries,
 * and it is what takes landing accuracy from "0.5px on every engine" to zero:
 * measured on Chromium, WebKit and Firefox in `spike/residual-carry`.
 */
export function carryFor(desired: number, actual: number): number {
  const residual = desired - actual
  if (!Number.isFinite(residual)) return 0
  if (Math.abs(residual) > MAX_CARRY) return 0
  return residual
}

/**
 * Round to the device pixel grid.
 *
 * Used only at the point of writing a visual offset to the DOM. The model stays
 * float64 throughout; rounding per item is what accumulates into visible drift
 * across thousands of comments.
 */
export function snapToDevicePixels(value: number, devicePixelRatio: number): number {
  if (!(devicePixelRatio > 0)) return value
  return Math.round(value * devicePixelRatio) / devicePixelRatio
}

/**
 * Convergence tolerance for a scroll target, in CSS px.
 *
 * One device pixel: tighter than this and the loop chases the browser's own
 * rounding forever, which is the feedback loop TanStack absorbs with a fixed
 * 1.01px tolerance — at the cost of being able to finish a full pixel short.
 * Scaling with the display instead keeps the bound as tight as the hardware
 * allows.
 */
export function convergenceTolerance(devicePixelRatio: number): number {
  return devicePixelRatio > 0 ? 1 / devicePixelRatio : 1
}
