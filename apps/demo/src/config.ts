import { THREAD_SIZE } from './thread.js'

/**
 * The demo's configuration, read once from the URL.
 *
 * At module scope because it cannot change without a reload, and because `main.tsx` needs
 * it before React renders — the engine is built during render, so a trace sink installed
 * in an effect would miss everything that happens at construction.
 *
 * This is what lets the accuracy suite drive the whole promised matrix against one build.
 * Without it the suite collapsed to a single axis: `scrollPaddingStart` was always 64,
 * `scrollMargin` always 0, the scroller was always the inner element, and the sub-pixel
 * assertion only ever ran for `align: 'start'`.
 */
export interface DemoConfig {
  /** Comment to deep-link to on load. */
  target: number
  paddingStart: number
  /**
   * Height of the measured `header` slot, in px.
   *
   * Replaces the old `scrollMargin` knob, which had to declare the same number
   * twice — once as the option and once as the slot's inline height — and was
   * therefore incapable of testing the case that matters: the two disagreeing.
   * A measured slot has only one number, so the suite exercises the library's
   * own measurement rather than the demo's arithmetic.
   */
  header: number
  /** Height of the measured `footer` slot, in px. */
  footer: number
  /** Height of the measured `stickyFooter` slot, in px. */
  stickyFooter: number
  /** Stay pinned to the newest comment as the thread grows. */
  follow: boolean
  /** Hold a thread too short to scroll against the bottom of the scroller. */
  alignToBottom: boolean
  windowScroller: boolean
  /** Load the entire thread, so targets sit deep in a large window. */
  loadAll: boolean
  /**
   * Open with exactly this many comments from the top, and page no further. 0 for the usual
   * window.
   *
   * The one state the demo could not otherwise reach: a list *short enough not to overflow*.
   * Every other mode opens on 40 comments or the whole thread, so the scroller has had a
   * scrollbar since before the first measurement — which makes the transition into having one
   * unobservable, and that transition is what `stableScrollbarGutter` exists for.
   *
   * Paging is off in this mode rather than merely unlikely: a list with no scroll range is
   * within reach of both its edges at once, so `onEdgeReached` would fire immediately and page
   * the shortness away before anything could look at it.
   */
  loaded: number
  /**
   * Reserve the scrollbar's width in the scrollport. Default on, as the library's is.
   *
   * Here to be turned *off*, so the suite can show what the default prevents rather than only
   * that it is applied.
   */
  stableGutter: boolean
  /** Report each comment at most once, rather than on every re-entry. */
  once: boolean
  /**
   * Which visibility rule to run — see `VisibilityRule` for what `edge` is for.
   *
   * The default stays `fraction` so every other scenario in the suite is unaffected.
   */
  rule: 'fraction' | 'edge'
  /** Collect the library's trace events into a ring buffer readable from the console. */
  trace: boolean
  /** Persist measured sizes to sessionStorage and restore them on the next load. */
  snapshot: boolean
  /**
   * Stop the demo re-rendering itself on every frame of a scroll.
   *
   * A measurement aid, not a feature. The panel's visible-range readout, its 60-row
   * visibility log and its read-count all live in React state fed from the list's
   * callbacks, so an ordinary fling re-renders the whole page on most frames. That is
   * the demo being a demo — but it is indistinguishable, by feel, from the *library*
   * stuttering, and until momentum survived at all on iOS there was never a fling long
   * enough to notice it. Turning it off is how you tell the two apart.
   *
   * With {@link debug} it stops being a matter of feel: run the same gesture twice, once with
   * `quiet=1` and once without, and compare the longest frame the toolkit reports. The difference
   * is this demo; the residue is the library. That differential is the only honest way to answer
   * the question, which is why the analyzer declines to guess at it from a single recording.
   */
  quiet: boolean
  /**
   * Load `virtual-anchor/debug` and diagnose every gesture.
   *
   * So a phone can be diagnosed without being tethered to a Mac for the Web Inspector: the
   * toolkit segments the trace into gestures, ranks the reasons a fling could have jumped or
   * stopped, prints the conclusion to the console and — under {@link overlay} — puts it on the
   * page with a way to export the JSON.
   *
   * Implies {@link trace}, since it reads the same stream. Replaces the old hand-rolled `hud`,
   * which is kept as an alias.
   */
  debug: boolean
  /** Mount the on-page readout. Default on with {@link debug}; turn it off for a headless recording. */
  overlay: boolean
  /**
   * Run the frame probe. Default on with {@link debug}.
   *
   * It is what separates "the fling was cancelled" from "the main thread was blocked", and it
   * costs one wakeup per frame — so it perturbs the timing it reports. `probe=0` is how you
   * confirm a timing finding without it.
   */
  probe: boolean
  /**
   * Show the live frame-rate readout. On for a person, off under automation; `fps=0`/`fps=1`
   * override either way.
   *
   * On by default because "how does it scroll" is the first question anyone opens this demo to
   * answer. Off under automation because it costs one `requestAnimationFrame` wakeup per frame —
   * the same price as {@link probe} — and both suites that drive this demo are measuring
   * something the wakeup would perturb: the accuracy suite asserts sub-pixel landings, and
   * `perf/` times frames.
   *
   * **Keyed on `navigator.webdriver` rather than on a query parameter, because the parameter did
   * not hold.** The first version defaulted this on and had `e2e/helpers.ts`'s `open()` inject
   * `fps=0`; but a good part of that suite calls `page.goto('/')` directly — `smoke.spec.ts:41`
   * and `:54` among them — so the opt-out covered some pages and not others, and the meter ran
   * inside tests that never asked for it. One predicate the browser itself supplies covers every
   * entry point, including ones nobody has written yet.
   */
  fps: boolean
  /** Which overlay panes to show. `verdict` is the useful one; `live` is for watching counters move. */
  mode: 'live' | 'verdict' | 'both'
  /** Trace ring capacity. Larger reaches further back; the toolkit says when it has dropped events. */
  record: number
  /**
   * Keep only these topic prefixes, comma-separated.
   *
   * `topics=scroll.,gesture.,frame.` roughly triples how far back a given capacity reaches, by
   * dropping the per-frame anchor and visibility topics.
   */
  topics: readonly string[] | undefined
}

export const SNAPSHOT_KEY = 'virtual-anchor-demo-sizes'

/** The demo's sticky header, and so its default `scrollPaddingStart`. */
const DEFAULT_HEADER_HEIGHT = 64

const params = new URLSearchParams(window.location.search)

const number = (name: string, fallback: number): number => {
  const raw = params.get(name)
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * `?debug=1`, or its old spelling.
 *
 * Named here rather than repeated on both the `trace` and `debug` lines, so "debug implies trace"
 * is expressed once and a third spelling would mean editing one place.
 *
 * `hud=1` is kept because it is in muscle memory and in bookmarks. Worth being clear that it is an
 * alias for the *param*, not for the old behaviour: it used to draw ten lines of scroll
 * corrections, and it now installs the whole toolkit. The bookmark neither breaks nor does what it
 * did.
 */
const debug = params.get('debug') === '1' || params.get('hud') === '1'

export const CONFIG: DemoConfig = {
  target: Math.min(Math.max(number('comment', 0), 0), THREAD_SIZE - 1),
  paddingStart: number('paddingStart', DEFAULT_HEADER_HEIGHT),
  header: number('header', 0),
  footer: number('footer', 0),
  stickyFooter: number('stickyFooter', 0),
  follow: params.get('follow') === '1',
  alignToBottom: params.get('alignToBottom') === '1',
  windowScroller: params.get('windowScroller') === '1',
  loadAll: params.get('loadAll') === '1',
  loaded: Math.max(0, number('loaded', 0)),
  stableGutter: params.get('stableGutter') !== '0',
  once: params.get('once') === '1',
  rule: params.get('rule') === 'edge' ? 'edge' : 'fraction',
  trace: params.get('trace') === '1' || debug,
  snapshot: params.get('snapshot') === '1',
  quiet: params.get('quiet') === '1',
  debug,
  overlay: params.get('overlay') !== '0',
  probe: params.get('probe') !== '0',
  // Explicit either way wins, so a spec can still ask for the meter with `fps=1`; otherwise it
  // follows whether a person or a driver is looking at the page.
  fps: params.get('fps') === '1' || (params.get('fps') !== '0' && !navigator.webdriver),
  mode: params.get('mode') === 'live' ? 'live' : params.get('mode') === 'verdict' ? 'verdict' : 'both',
  record: Math.max(100, number('record', 5000)),
  topics: params.get('topics')?.split(',').filter(Boolean),
}

/**
 * Whether the loaded window is decided at load and never moves.
 *
 * Two modes want it for opposite reasons — `loadAll` because there is nothing left to page,
 * `loaded` because paging would undo the state it exists to create — and the three places that
 * page all have to agree, which they did not when only one of the two was spelled at each of
 * them.
 */
export const FIXED_WINDOW = CONFIG.loadAll || CONFIG.loaded > 0
