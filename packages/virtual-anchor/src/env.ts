/**
 * Whether this is iOS WebKit, where writing `scrollTop` during momentum
 * scrolling cancels the fling.
 *
 * The `MacIntel` clause is not redundant: since iPadOS 13, iPad reports a
 * desktop platform string and a desktop user agent, so a naive `/iPad/` test
 * misses every modern iPad. Touch points are what actually distinguishes it from
 * a Mac. Both TanStack Virtual and virtua arrived at this same pair of checks
 * independently, which is decent evidence there is no cleaner signal.
 */
export function isIOSWebKit(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false

  const isIPhoneLike = /iP(hone|od|ad)/.test(navigator.userAgent)

  // `navigator.platform` is deprecated, and its replacement
  // (`navigator.userAgentData`) is not implemented in Safari — the very engine
  // this function exists to detect. So it stays, narrowed to the one case the
  // user agent cannot answer: an iPad claiming to be a Mac.
  const isIPadOS13Plus = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 0

  if (!isIPhoneLike && !isIPadOS13Plus) return false

  // Chrome and Firefox on iOS are WebKit underneath, so no engine check is
  // needed — but a desktop Mac with a touch display must not match.
  return 'ontouchend' in window
}

/**
 * Whether the native `scrollend` event is available.
 *
 * Baseline since Safari 26.2 completed Chrome/Edge 114 and Firefox 109. Where it
 * is missing, the settle detection falls back to a timeout so a scroll promise
 * can never hang, and the README points consumers at the optional `scrollyfills`
 * peer dependency if they need better fidelity on older Safari.
 */
export function supportsScrollEnd(): boolean {
  return typeof window !== 'undefined' && 'onscrollend' in window
}

/** Whether the user has asked for reduced motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Device pixel ratio, defaulting to 1 outside a browser. */
export function devicePixelRatioOf(view: Window | null | undefined): number {
  const ratio = view?.devicePixelRatio
  return typeof ratio === 'number' && ratio > 0 ? ratio : 1
}
