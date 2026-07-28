import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElementViewport, createWindowViewport } from './viewport.js'

/** jsdom reports zero for layout, so the values a real engine would give are stubbed. */
const stubLayout = (
  element: HTMLElement,
  layout: { scrollHeight: number; clientHeight: number; clientTop?: number; top?: number },
): void => {
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    value: layout.scrollHeight,
  })
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: layout.clientHeight,
  })
  Object.defineProperty(element, 'clientTop', {
    configurable: true,
    value: layout.clientTop ?? 0,
  })
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, layout.top ?? 0, 400, layout.clientHeight),
  )
}

beforeEach(() => {
  document.body.replaceChildren()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createElementViewport', () => {
  const setup = () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    stubLayout(element, { scrollHeight: 10_000, clientHeight: 600, clientTop: 1, top: 50 })
    return { element, viewport: createElementViewport(element) }
  }

  it('reads and writes the scroll offset', () => {
    const { element, viewport } = setup()
    expect(viewport.getScrollOffset()).toBe(0)

    viewport.setScrollOffset(1204.5)
    expect(element.scrollTop).toBe(1204.5)
    expect(viewport.getScrollOffset()).toBe(1204.5)
  })

  it('reports the visible extent', () => {
    const { viewport } = setup()
    expect(viewport.getViewportSize()).toBe(600)
  })

  it('takes the maximum offset from the DOM, not from an estimate', () => {
    // Clamping against our own estimated total is the root cause of TanStack
    // #1001: the estimate is not the document.
    const { viewport } = setup()
    expect(viewport.getMaxScrollOffset()).toBe(9400)
  })

  it('never reports a negative maximum for unscrollable content', () => {
    const element = document.createElement('div')
    stubLayout(element, { scrollHeight: 100, clientHeight: 600 })
    expect(createElementViewport(element).getMaxScrollOffset()).toBe(0)
  })

  it('adds the border when reporting the content top', () => {
    // getBoundingClientRect().top is the border-box top; content starts inside
    // the border. Missing this read a 1px border as a 1px accuracy failure.
    const { viewport } = setup()
    expect(viewport.getContentClientTop()).toBe(51)
  })

  it('subscribes passively and unsubscribes cleanly', () => {
    const { element, viewport } = setup()
    const add = vi.spyOn(element, 'addEventListener')
    const remove = vi.spyOn(element, 'removeEventListener')
    const listener = vi.fn()

    const off = viewport.addEventListener('scroll', listener)
    expect(add).toHaveBeenCalledWith('scroll', listener, { passive: true })

    element.dispatchEvent(new Event('scroll'))
    expect(listener).toHaveBeenCalledOnce()

    off()
    element.dispatchEvent(new Event('scroll'))
    expect(listener).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('scroll', listener)
  })

  it('exposes the element and its own window for observers', () => {
    const { element, viewport } = setup()
    expect(viewport.getElement()).toBe(element)
    expect(viewport.getWindow()).toBe(window)
  })

  it('reports the device pixel ratio, defaulting sensibly', () => {
    const { viewport } = setup()
    expect(viewport.getDevicePixelRatio()).toBeGreaterThan(0)
  })
})

describe('createWindowViewport', () => {
  const stubWindow = (values: {
    scrollY?: number
    innerHeight?: number
    scrollHeight?: number
  }): void => {
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: values.scrollY ?? 0,
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: values.innerHeight ?? 800,
    })
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: values.scrollHeight ?? 20_000,
    })
  }

  it('reads the offset from the window and the extent from the document', () => {
    // The platform forces this asymmetry: scrollY from the window, scrollHeight
    // from documentElement, and innerHeight rather than clientHeight so mobile
    // URL-bar behaviour is accounted for.
    stubWindow({ scrollY: 1500, innerHeight: 800, scrollHeight: 20_000 })
    const viewport = createWindowViewport(window)

    expect(viewport.getScrollOffset()).toBe(1500)
    expect(viewport.getViewportSize()).toBe(800)
    expect(viewport.getMaxScrollOffset()).toBe(19_200)
  })

  it('never reports a negative maximum for a short page', () => {
    stubWindow({ innerHeight: 800, scrollHeight: 400 })
    expect(createWindowViewport(window).getMaxScrollOffset()).toBe(0)
  })

  it('scrolls the window without animating', () => {
    stubWindow({})
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

    createWindowViewport(window).setScrollOffset(940.25)
    // Explicit 'auto': a stray `scroll-behavior: smooth` would otherwise animate
    // every corrective write and fight the convergence loop.
    expect(scrollTo).toHaveBeenCalledWith({ top: 940.25, behavior: 'auto' })
  })

  it('treats the content top as the top of the viewport', () => {
    stubWindow({})
    expect(createWindowViewport(window).getContentClientTop()).toBe(0)
  })

  it('subscribes on the window and unsubscribes cleanly', () => {
    stubWindow({})
    const viewport = createWindowViewport(window)
    const listener = vi.fn()

    const off = viewport.addEventListener('scroll', listener)
    window.dispatchEvent(new Event('scroll'))
    expect(listener).toHaveBeenCalledOnce()

    off()
    window.dispatchEvent(new Event('scroll'))
    expect(listener).toHaveBeenCalledOnce()
  })

  it('exposes the documentElement for observers', () => {
    stubWindow({})
    const viewport = createWindowViewport(window)
    expect(viewport.getElement()).toBe(document.documentElement)
    expect(viewport.getWindow()).toBe(window)
  })
})
