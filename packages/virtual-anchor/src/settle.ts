import { supportsScrollEnd } from './env.js'
import type { Viewport } from './viewport.js'

/** Fallback settle timeout where `scrollend` is unavailable. */
const SCROLL_END_FALLBACK_MS = 150

/**
 * Settle detection: the native `scrollend` event where available, a timeout
 * otherwise.
 *
 * `scrollend` became baseline when Safari 26.2 joined Chrome/Edge 114 and
 * Firefox 109. Two things make a fallback mandatory regardless: it does not fire
 * at all when the scroll position did not change, and older Safari lacks it
 * entirely. The README points those consumers at the optional `scrollyfills`
 * peer dependency.
 *
 * Lives in its own module rather than in `scroller.ts`, where it was, because
 * the momentum gate needs it too and `scroller.ts` imports the gate — a cycle
 * that ESM would tolerate and every reader would have to re-derive. Still
 * re-exported from `scroller.js` so the public entry point is unchanged.
 */
export function onScrollSettled(viewport: Viewport, callback: () => void): () => void {
  if (supportsScrollEnd()) {
    return viewport.addEventListener('scrollend', callback)
  }

  let timer: ReturnType<typeof setTimeout> | null = null

  const off = viewport.addEventListener('scroll', () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(callback, SCROLL_END_FALLBACK_MS)
  })

  return () => {
    if (timer !== null) clearTimeout(timer)
    off()
  }
}
