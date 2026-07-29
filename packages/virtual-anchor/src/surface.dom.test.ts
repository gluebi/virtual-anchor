import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDomSurface, createNullSurface } from './surface.js'

const setup = () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const surface = createDomSurface({ container: { current: container } })
  return { container, surface }
}

const item = (): HTMLElement => {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return element
}

beforeEach(() => {
  document.body.replaceChildren()
})

describe('createDomSurface content size', () => {
  it('writes the content height', () => {
    const { container, surface } = setup()
    surface.setContentSize(12_345.75)
    expect(container.style.height).toBe('12345.75px')
  })

  it('does not re-write an unchanged size', () => {
    const { container, surface } = setup()
    surface.setContentSize(1000)
    const spy = vi.spyOn(container.style, 'height', 'set')

    surface.setContentSize(1000)
    expect(spy).not.toHaveBeenCalled()

    surface.setContentSize(1001)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('tolerates a container that has not attached yet', () => {
    const surface = createDomSurface({ container: { current: null } })
    expect(() => {
      surface.setContentSize(500)
    }).not.toThrow()
  })
})

describe('createDomSurface carry', () => {
  it('shifts the container up by the residual', () => {
    // Positive carry means the browser stopped short of where we wanted, so content
    // moves up to compensate.
    const { container, surface } = setup()
    surface.setCarry(0.5)
    expect(container.style.top).toBe('-0.5px')
  })

  it('uses `top` rather than a transform', () => {
    // A fractional translate disables subpixel text antialiasing in Blink for the whole
    // subtree (crbug 573146) — and a sub-pixel carry is fractional by definition.
    const { container, surface } = setup()
    surface.setCarry(0.25)
    expect(container.style.transform).toBe('')
    expect(container.style.top).toBe('-0.25px')
  })

  it('clears the offset at zero rather than writing -0px', () => {
    const { container, surface } = setup()
    surface.setCarry(0.5)
    surface.setCarry(0)
    expect(container.style.top).toBe('')
  })

  it('does not re-write an unchanged carry', () => {
    const { container, surface } = setup()
    surface.setCarry(0.5)
    const spy = vi.spyOn(container.style, 'top', 'set')

    surface.setCarry(0.5)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('createDomSurface item positioning', () => {
  it('positions an attached item', () => {
    const { surface } = setup()
    const element = item()
    surface.attachItem('a', element)

    surface.setItemOffset('a', 1234.5)
    expect(element.style.top).toBe('1234.5px')
    expect(element.style.position).toBe('absolute')
    expect(element.style.left).toBe('0px')
    expect(element.style.right).toBe('0px')
  })

  it('writes the exact float, unsnapped', () => {
    // Painted position is `itemTop - scrollTop - carry`, which reduces to
    // `itemTop - target` and is exact whatever the platform did to the scroll offset.
    // Rounding here as well is a second compensation for the same problem: the two
    // roundings cancel and the carry then breaks the cancellation, which put every
    // landing exactly half a pixel out.
    const { surface } = setup()
    const element = item()
    surface.attachItem('a', element)

    surface.setItemOffset('a', 3391.5)
    expect(element.style.top).toBe('3391.5px')
  })

  it('writes the invariant styles once, not on every move', () => {
    const { surface } = setup()
    const element = item()
    surface.attachItem('a', element)
    surface.setItemOffset('a', 100)

    const position = vi.spyOn(element.style, 'position', 'set')
    const left = vi.spyOn(element.style, 'left', 'set')

    surface.setItemOffset('a', 200)
    surface.setItemOffset('a', 300)
    expect(position).not.toHaveBeenCalled()
    expect(left).not.toHaveBeenCalled()
  })

  it('does not re-write an unchanged offset', () => {
    const { surface } = setup()
    const element = item()
    surface.attachItem('a', element)
    surface.setItemOffset('a', 100)

    const top = vi.spyOn(element.style, 'top', 'set')
    surface.setItemOffset('a', 100)
    expect(top).not.toHaveBeenCalled()

    surface.setItemOffset('a', 101)
    expect(top).toHaveBeenCalledOnce()
  })

  it('ignores an offset for a key with no element', () => {
    const { surface } = setup()
    expect(() => {
      surface.setItemOffset('missing', 100)
    }).not.toThrow()
  })
})

describe('createDomSurface element registry', () => {
  it('tracks and forgets elements', () => {
    const { surface } = setup()
    const element = item()

    const detach = surface.attachItem('a', element)
    expect(surface.hasItem('a')).toBe(true)

    detach()
    expect(surface.hasItem('a')).toBe(false)
  })

  it('keeps the newer element when one replaces another for the same key', () => {
    // React can attach a replacement before detaching the element it replaced, so a
    // naive delete-on-detach would forget the live one.
    const { surface } = setup()
    const first = item()
    const second = item()

    const detachFirst = surface.attachItem('a', first)
    surface.attachItem('a', second)
    detachFirst()

    expect(surface.hasItem('a')).toBe(true)
    surface.setItemOffset('a', 42)
    expect(second.style.top).toBe('42px')
    expect(first.style.top).toBe('')
  })

  it('focuses an attached item and reports whether it could', () => {
    const { surface } = setup()
    const element = item()
    element.tabIndex = 0
    surface.attachItem('a', element)

    expect(surface.focusItem('a')).toBe(true)
    expect(document.activeElement).toBe(element)
    expect(surface.focusItem('missing')).toBe(false)
  })

  it('forgets everything on dispose', () => {
    const { surface } = setup()
    surface.attachItem('a', item())
    surface.dispose()
    expect(surface.hasItem('a')).toBe(false)
  })
})

describe('createNullSurface', () => {
  it('accepts every call and draws nothing', () => {
    const surface = createNullSurface()
    expect(() => {
      surface.setContentSize(100)
      surface.setCarry(0.5)
      surface.setItemOffset('a', 10)
      surface.attachItem('a', document.createElement('div'))()
      surface.dispose()
    }).not.toThrow()

    expect(surface.hasItem('a')).toBe(false)
    expect(surface.focusItem('a')).toBe(false)
  })
})
