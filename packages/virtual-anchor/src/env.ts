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

/**
 * Call back whenever the device pixel ratio changes.
 *
 * There is no event for `devicePixelRatio`, so this is the standard trick: a resolution
 * media query matches only the ratio it names, and stops matching the moment the ratio
 * moves. Which means it has to be re-armed against the new value each time — one query
 * cannot answer "has this changed" more than once.
 *
 * What produces a change, in rough order of how often: browser page zoom, which is the
 * common one and lands on fractional ratios; a window dragged between displays of different
 * scale factors; and an OS scaling change applied live.
 *
 * Why the library cares at all, since CSS pixel layout is *nominally* ratio-independent —
 * measured on the demo at a fixed 1280px viewport, first six rows:
 *
 * | ratio      | Chromium | Firefox | WebKit      |
 * | ---------- | -------- | ------- | ----------- |
 * | 1, 2, 3    | 277.25   | 277.25  | 277.25      |
 * | 1.25       | 277.25   | 277.25  | **276.84375** |
 *
 * So on WebKit at a fractional ratio every row is 0.40625px shorter, uniformly. Per row that
 * is invisible; across a few thousand it is a wrong scroll extent and a landing that misses,
 * which is the whole failure mode this library exists to avoid. Integer ratios agree exactly
 * on all three engines, and Chromium and Firefox agree everywhere.
 */
export function observeResolution(
  view: Window | null | undefined,
  onChange: () => void,
): () => void {
  if (!view || typeof view.matchMedia !== 'function') return () => {}
  const win = view

  // Takes the query it replaces and returns the one now armed, so there is no moment where
  // `query` is unset and no unreachable null check guarding it. `handle` is a declaration
  // rather than a const because `arm` names it before it is written.
  function handle(): void {
    onChange()
    query = arm(query)
  }

  function arm(previous: MediaQueryList | null): MediaQueryList {
    previous?.removeEventListener('change', handle)
    const next = win.matchMedia(`(resolution: ${String(devicePixelRatioOf(win))}dppx)`)
    next.addEventListener('change', handle)
    return next
  }

  let query = arm(null)

  return () => {
    query.removeEventListener('change', handle)
  }
}
