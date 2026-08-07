/**
 * An on-page readout, for diagnosing a device that is not plugged into anything.
 *
 * Grown out of the demo's `?hud=1` overlay, and it keeps that overlay's central decision:
 * **not React.** The original comment put it correctly — "it updates on every correction, and
 * re-rendering the app to show diagnostics would change the very thing being diagnosed" — and
 * that reasoning belongs to the tool rather than to the demo, which is why it now lives here.
 *
 * Four things it does differently, each of which was a defect in the original.
 *
 * **Two panes, and the second is the point.** A live readout at 120 Hz is unreadable during a
 * fling, and the finger is on the glass in front of it anyway. So there is a one-line strip
 * that moves, and a verdict pane that updates once per gesture, when it settles. The
 * post-mortem is the artefact worth having.
 *
 * **Repaint is coalesced.** The original wrote `hud.textContent` on every `scroll.write` — 43
 * text-node rebuilds and 43 style invalidations in one bad gesture, inside the gesture being
 * measured. Here every event moves plain numbers, and the DOM is written at most `refreshHz`
 * times a second, from the shared frame driver, and only when something changed.
 *
 * **It never reads layout.** `contain: layout style paint`, a fixed line count, and no
 * geometry reads at all, so the overlay cannot appear in the measurements it is displaying.
 *
 * **`pointer-events: none` on everything that displays.** This is not tidiness. The thing being
 * diagnosed is a fling; an overlay that swallowed a `touchstart` would both destroy the
 * measurement and shut the write gate — so the instrument would be manufacturing the very
 * hypothesis it is meant to test. Only a small control strip accepts input, and it sits in the
 * opposite corner from the scroll path with `touch-action: none`, so a drag that begins on a
 * button cannot scroll anything.
 */

import { lastGesture, type GestureVerdict } from './analyzer.js'
import { createFrameDriver, type FrameDriver } from './driver.js'
import { formatLive, formatVerdict } from './format.js'
import type { TraceRecorder } from './recorder.js'

export interface TraceHudOptions {
  /** Where the events come from. */
  recorder: TraceRecorder
  driver?: FrameDriver
  /** Which panes to show. Default `'both'`. */
  mode?: 'live' | 'verdict' | 'both'
  /** How often the live strip may repaint. Default 10. */
  refreshHz?: number
  /** Where to mount. Default `document.body`, deliberately outside any framework root. */
  container?: HTMLElement
}

export interface TraceHud {
  /** Recompute now, rather than waiting for the next gesture to settle. */
  refresh(): void
  verdict(): GestureVerdict | null
  reset(): void
  dispose(): void
}

const PANEL_STYLE = [
  'position:fixed',
  'left:0',
  'right:0',
  'bottom:0',
  'z-index:2147483646',
  'background:rgba(0,0,0,.86)',
  'color:#0f0',
  'font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace',
  'padding:6px 8px',
  'white-space:pre',
  'max-height:46vh',
  'overflow:hidden',
  // Never intercepts a gesture. See the module comment — this one property is what keeps the
  // instrument from creating the condition it is measuring.
  'pointer-events:none',
  // Bounds the work a repaint can cause, so a text change cannot relayout the page the list
  // is scrolling inside.
  'contain:layout style paint',
].join(';')

const CONTROLS_STYLE = [
  'position:fixed',
  'right:6px',
  'top:6px',
  'z-index:2147483647',
  'display:flex',
  'gap:6px',
  // The one part that must accept input, so it is also the one part that must not be where a
  // thumb flings. Top-right, away from the list's scroll path.
  'pointer-events:auto',
  'touch-action:none',
].join(';')

const BUTTON_STYLE = [
  'font:11px/1 ui-monospace,monospace',
  'padding:6px 8px',
  'background:#111',
  'color:#0f0',
  'border:1px solid #0f0',
  'border-radius:4px',
  'touch-action:none',
].join(';')

export function mountTraceHud(options: TraceHudOptions): TraceHud {
  const { recorder } = options
  const mode = options.mode ?? 'both'
  const driver = options.driver ?? createFrameDriver()
  const container = options.container ?? document.body
  const minInterval = 1000 / (options.refreshHz ?? 10)

  const panel = document.createElement('pre')
  panel.setAttribute('data-virtual-anchor-hud', '')
  panel.style.cssText = PANEL_STYLE
  container.appendChild(panel)

  const controls = document.createElement('div')
  controls.style.cssText = CONTROLS_STYLE
  container.appendChild(controls)

  let current: GestureVerdict | null = null
  let painted = ''
  /**
   * The recorder revision `current` was computed from, so an unchanged buffer is not re-analysed.
   *
   * Without this the frame callback re-segmented and re-summarised the ring on every repaint —
   * ten times a second, forever, including on a completely idle page, and including *during* the
   * fling this is here to observe. `-1` so the first frame always computes.
   */
  let analysedAt = -1
  /**
   * When the panel last drew. `-Infinity` so the *first* frame always draws.
   *
   * Starting it at zero throttled the opening paint against the refresh interval, which left the
   * overlay blank for the first tenth of a second after mounting — long enough to read as "the
   * tool is broken" rather than "the tool is waiting".
   */
  let lastPaintAt = -Infinity

  const compute = (): void => {
    analysedAt = recorder.revision()
    current = lastGesture(recorder.select(), recorder.dropped())
  }

  const render = (): void => {
    const live = mode === 'verdict' ? '' : formatLive(current)
    const report = mode === 'live' ? '' : formatVerdict(current)
    const next = mode === 'both' ? `${live}\n\n${report}` : `${live}${report}`
    // Only when it actually changed. Assigning identical text still invalidates style.
    if (next === painted) return
    painted = next
    panel.textContent = next
  }

  const stopFrames = driver.onFrame((at) => {
    if (at - lastPaintAt < minInterval) return
    // Nothing new to say. One integer compare, where this used to be a full pass over the ring.
    if (recorder.revision() === analysedAt) return
    lastPaintAt = at
    compute()
    render()
  })

  /**
   * Export, and the awkward truth about how.
   *
   * `navigator.clipboard` and `navigator.share` both require a **secure context**, and the
   * scenario this whole module exists for is a phone pointed at `http://<lan-ip>:4173` from
   * `vite preview --host` — which is not one. So on the device that matters they are simply
   * `undefined`, tap or no tap.
   *
   * What does work over plain HTTP is a `Blob` download, which lands in Files and leaves by
   * AirDrop or Mail. So that is the default, and a `<textarea>` is the fallback, being both
   * secure-context-free and the only human-readable option — a long press gives Share.
   *
   * Only those two are offered, rather than four with two of them silently failing on the device
   * that matters most.
   */
  const button = (label: string, onTap: () => void): void => {
    const element = document.createElement('button')
    element.type = 'button'
    element.textContent = label
    element.style.cssText = BUTTON_STYLE
    element.addEventListener('click', onTap)
    controls.appendChild(element)
  }

  /** The last gesture only: a full 5,000-event ring is ~700 kB and unusable in a textarea. */
  const reportJson = (): string => {
    const since = current?.startedAt
    return recorder.toJSON(since === undefined ? undefined : { since })
  }

  button('save', () => {
    const blob = new Blob([reportJson()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'virtual-anchor-trace.json'
    link.click()
    // Not immediately: Safari has not necessarily started reading the blob when `click`
    // returns, and revoking too early produces an empty file.
    setTimeout(() => {
      URL.revokeObjectURL(url)
    }, 10_000)
  })

  button('show', () => {
    const sheet = document.createElement('textarea')
    sheet.readOnly = true
    sheet.value = reportJson()
    sheet.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'width:100%',
      'height:100%',
      'font:10px/1.3 ui-monospace,monospace',
      'pointer-events:auto',
    ].join(';')
    sheet.addEventListener('dblclick', () => {
      sheet.remove()
    })
    container.appendChild(sheet)
    sheet.select()
  })

  const reset = (): void => {
    recorder.clear()
    current = null
    painted = ''
    analysedAt = recorder.revision()
    panel.textContent = 'reset'
  }

  button('reset', reset)

  return {
    refresh() {
      compute()
      render()
    },
    verdict: () => current,
    reset,
    dispose() {
      stopFrames()
      panel.remove()
      controls.remove()
    },
  }
}
