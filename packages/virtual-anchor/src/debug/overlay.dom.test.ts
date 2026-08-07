import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { trace } from '../trace.js'
import { createFrameDriver } from './driver.js'
import { mountTraceHud, type TraceHud } from './overlay.js'
import { createTraceRecorder, type TraceRecorder } from './recorder.js'

/**
 * The on-page readout.
 *
 * What matters here is not what it says — `format.test.ts` covers that — but that it cannot
 * disturb the gesture it is reporting on. So: one DOM write per repaint window rather than one
 * per event, no layout reads, and no interception of touches.
 */

let frames: ((at: number) => void)[] = []
let now = 0
const tick = (ms: number): void => {
  now += ms
  const due = frames
  frames = []
  for (const callback of due) callback(now)
}

let recorder: TraceRecorder
let hud: TraceHud | undefined

beforeEach(() => {
  frames = []
  now = 0
  vi.stubGlobal('requestAnimationFrame', (callback: (at: number) => void) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  recorder = createTraceRecorder()
})

afterEach(() => {
  hud?.dispose()
  recorder.dispose()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const mount = (options: Partial<Parameters<typeof mountTraceHud>[0]> = {}): TraceHud => {
  hud = mountTraceHud({ recorder, driver: createFrameDriver(globalThis.window), ...options })
  return hud
}

const panel = (): HTMLElement | null => document.querySelector('[data-virtual-anchor-hud]')

/** touchstart → a scroll → settle, which is the minimum the analyzer will report on. */
const gesture = (): void => {
  trace('gesture.touch', () => ({ phase: 'start', y: 400, dy: 0, ms: 0, moves: 0, velocity: 0 }))
  trace('scroll.sample', () => ({ offset: 100, carry: 0, shift: 0 }))
  trace('gesture.touch', () => ({ phase: 'end', y: 300, dy: 100, ms: 60, moves: 3, velocity: -1 }))
  trace('scroll.gate', () => ({ state: 'idle', reason: 'settled' }))
}

describe('mounting', () => {
  it('goes outside any framework root, so a repaint cannot re-render the app', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    mount()
    expect(panel()?.parentElement).toBe(document.body)
    expect(root.children).toHaveLength(0)
  })

  it('honours a container when one is given', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    mount({ container })
    expect(panel()?.parentElement).toBe(container)
  })

  it('never intercepts a touch on the readout itself', () => {
    // Not tidiness. The thing being diagnosed is a fling, and an overlay that swallowed a
    // `touchstart` would both destroy the measurement and shut the write gate — so the
    // instrument would be manufacturing the hypothesis it exists to test.
    mount()
    expect(panel()?.style.pointerEvents).toBe('none')
  })

  it('bounds what a repaint can relayout', () => {
    mount()
    expect(panel()?.style.contain).toBe('layout style paint')
  })

  it('accepts input only on its controls', () => {
    mount()
    const buttons = [...document.querySelectorAll('button')]
    expect(buttons.length).toBeGreaterThan(0)
    for (const button of buttons) {
      expect(button.parentElement?.style.pointerEvents).toBe('auto')
      // So a drag beginning on a button cannot scroll anything.
      expect(button.style.touchAction).toBe('none')
    }
  })

  it('removes itself and its controls on dispose', () => {
    mount().dispose()
    expect(panel()).toBeNull()
    expect(document.querySelector('button')).toBeNull()
  })
})

describe('repainting', () => {
  it('writes the DOM once per window however many events arrive', () => {
    mount({ refreshHz: 10 })
    const element = panel()
    if (element === null) throw new Error('no panel')
    const write = vi.spyOn(element, 'textContent', 'set')

    // The original HUD wrote `textContent` on every `scroll.write` — 43 text-node rebuilds in one
    // bad gesture, inside the gesture being measured.
    for (let i = 0; i < 60; i++) trace('scroll.sample', () => ({ offset: i, carry: 0, shift: 0 }))
    tick(16)

    expect(write).toHaveBeenCalledTimes(1)
  })

  it('does not write at all when nothing changed', () => {
    mount({ refreshHz: 1000 })
    const element = panel()
    if (element === null) throw new Error('no panel')
    tick(16)
    const write = vi.spyOn(element, 'textContent', 'set')

    tick(16)
    tick(16)

    // Assigning identical text still invalidates style, so an unchanged verdict must not be
    // re-assigned.
    expect(write).not.toHaveBeenCalled()
  })

  it('respects the refresh interval', () => {
    mount({ refreshHz: 10 })
    const element = panel()
    if (element === null) throw new Error('no panel')

    // The opening paint, which is deliberately not throttled.
    tick(16)
    const write = vi.spyOn(element, 'textContent', 'set')

    // Content that genuinely differs, so what is being tested is the throttle rather than the
    // unchanged-text guard.
    gesture()
    tick(16)
    expect(write).not.toHaveBeenCalled()

    tick(120)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('does not re-analyse an unchanged buffer', () => {
    // The analysis, not the paint, was the expensive half: every repaint re-segmented and
    // re-summarised the whole ring — ten times a second, forever, including on an idle page.
    mount({ refreshHz: 1000 })
    gesture()
    tick(16)
    const before = recorder.select().length
    const analyse = vi.spyOn(recorder, 'select')

    tick(16)
    tick(16)

    expect(analyse).not.toHaveBeenCalled()
    // And it does analyse again as soon as there is something new to say.
    trace('scroll.sample', () => ({ offset: 99, carry: 0, shift: 0 }))
    tick(16)
    expect(analyse).toHaveBeenCalled()
    expect(recorder.select().length).toBeGreaterThan(before)
  })

  it('never reads layout', () => {
    // A readout that measured the page could appear in the measurements it is displaying.
    const read = vi.fn(() => 0)
    const proto = Element.prototype as unknown as Record<string, unknown>
    const original = Object.getOwnPropertyDescriptor(proto, 'scrollTop')
    Object.defineProperty(proto, 'scrollTop', { configurable: true, get: read })
    try {
      mount()
      gesture()
      tick(16)
      expect(read).not.toHaveBeenCalled()
    } finally {
      if (original) Object.defineProperty(proto, 'scrollTop', original)
    }
  })
})

describe('what it shows', () => {
  it('waits, visibly, before a gesture has happened', () => {
    mount()
    tick(16)
    expect(panel()?.textContent).toContain('waiting for a gesture')
  })

  it('reports a gesture once it has settled', () => {
    mount()
    gesture()
    tick(16)
    expect(panel()?.textContent).toContain('ended: settled')
  })

  it('shows only the live strip in live mode', () => {
    mount({ mode: 'live' })
    gesture()
    tick(16)
    expect(panel()?.textContent).toContain('gate')
    expect(panel()?.textContent).not.toContain('no suspect found')
  })

  it('shows only the post-mortem in verdict mode', () => {
    mount({ mode: 'verdict' })
    gesture()
    tick(16)
    expect(panel()?.textContent).toContain('ended: settled')
    expect(panel()?.textContent).not.toMatch(/^gate/)
  })

  it('exposes the verdict for a caller that wants the numbers', () => {
    const readout = mount()
    gesture()
    readout.refresh()
    expect(readout.verdict()?.ended).toBe('settled')
  })

  it('clears the record on reset', () => {
    const readout = mount()
    gesture()
    readout.refresh()
    readout.reset()
    expect(recorder.size()).toBe(0)
    expect(readout.verdict()).toBeNull()
    expect(panel()?.textContent).toBe('reset')
  })
})

describe('exporting', () => {
  it('offers a download, which is the mechanism that works over plain http', () => {
    // `navigator.clipboard` and `navigator.share` are secure-context only, and the scenario this
    // exists for is a phone pointed at `http://<lan-ip>:4173`.
    mount()
    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toContain('save')
    expect(labels).toContain('show')
  })

  it('puts the report on screen as selectable text', () => {
    mount()
    gesture()
    const show = [...document.querySelectorAll('button')].find((b) => b.textContent === 'show')
    show?.click()

    const sheet = document.querySelector('textarea')
    expect(sheet).not.toBeNull()
    expect(sheet?.readOnly).toBe(true)
    const parsed = JSON.parse(sheet?.value ?? '{}') as { events: unknown[] }
    expect(parsed.events.length).toBeGreaterThan(0)
  })
})
