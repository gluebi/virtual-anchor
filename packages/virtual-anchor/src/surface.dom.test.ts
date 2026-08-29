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

describe('createDomSurface leading space', () => {
  it('holds space above the items as a container margin', () => {
    // A margin rather than a spacer element: the container is already owned here
    // and its height is already written here, so one more style costs nothing —
    // where a spacer would need a node in every adapter and a ref to reach it.
    const { container, surface } = setup()
    surface.setLeadingSpace(500)
    expect(container.style.marginTop).toBe('500px')
  })

  it('clears the margin at zero rather than writing 0px', () => {
    const { container, surface } = setup()
    surface.setLeadingSpace(500)
    surface.setLeadingSpace(0)
    expect(container.style.marginTop).toBe('')
  })

  it('does not re-write an unchanged value', () => {
    const { container, surface } = setup()
    surface.setLeadingSpace(120)
    const spy = vi.spyOn(container.style, 'marginTop', 'set')

    surface.setLeadingSpace(120)
    expect(spy).not.toHaveBeenCalled()

    surface.setLeadingSpace(121)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('tolerates a container that has not attached yet', () => {
    const surface = createDomSurface({ container: { current: null } })
    expect(() => {
      surface.setLeadingSpace(300)
    }).not.toThrow()
  })

  it('is forgotten on dispose, so a reused surface writes it again', () => {
    const { container, surface } = setup()
    surface.setLeadingSpace(400)
    surface.dispose()
    container.style.marginTop = ''

    surface.setLeadingSpace(400)
    expect(container.style.marginTop).toBe('400px')
  })
})

describe('createDomSurface trailing space', () => {
  it('holds space below the items as container padding', () => {
    // Padding rather than a margin, unlike its counterpart above: the sticky footer
    // slot is the container's next sibling, and adjacent siblings' margins collapse —
    // so a consumer's own margin on that wrapper would take the max rather than the
    // sum and leave the composer short of the edge by their margin.
    const { container, surface } = setup()
    surface.setTrailingSpace(200)
    expect(container.style.paddingBottom).toBe('200px')
  })

  it('adds to the written height rather than coming out of it', () => {
    // The whole mechanism, and the one line of it that is easy to lose. Almost every
    // app carries `* { box-sizing: border-box }` — the demo included — under which the
    // padding would be absorbed into the height and the footer would not move a pixel.
    const { container, surface } = setup()
    container.style.boxSizing = 'border-box'

    surface.setContentSize(300)
    surface.setTrailingSpace(200)

    expect(container.style.boxSizing).toBe('content-box')
  })

  it('settles the box model before the height, not when a composer arrives', () => {
    // A box model that flipped the moment a sticky footer mounted would reinterpret the
    // height already written — and `width: 100%` with it — at that instant, for every
    // list that has one. So it is an invariant of the container, written on first sight.
    const { container, surface } = setup()
    container.style.boxSizing = 'border-box'

    surface.setContentSize(300)

    expect(container.style.boxSizing).toBe('content-box')
  })

  it('clears the padding at zero rather than writing 0px', () => {
    const { container, surface } = setup()
    surface.setTrailingSpace(200)
    surface.setTrailingSpace(0)
    expect(container.style.paddingBottom).toBe('')
  })

  it('does not re-write an unchanged value', () => {
    const { container, surface } = setup()
    surface.setTrailingSpace(120)
    const spy = vi.spyOn(container.style, 'paddingBottom', 'set')

    surface.setTrailingSpace(120)
    expect(spy).not.toHaveBeenCalled()

    surface.setTrailingSpace(121)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('tolerates a container that has not attached yet', () => {
    const surface = createDomSurface({ container: { current: null } })
    expect(() => {
      surface.setTrailingSpace(300)
    }).not.toThrow()
  })

  it('is forgotten on dispose, so a reused surface writes it again', () => {
    const { container, surface } = setup()
    surface.setTrailingSpace(400)
    surface.dispose()
    container.style.paddingBottom = ''

    surface.setTrailingSpace(400)
    expect(container.style.paddingBottom).toBe('400px')
  })
})

describe('createDomSurface paint offset', () => {
  it('shifts the container up by the residual', () => {
    // Positive carry means the browser stopped short of where we wanted, so content
    // moves up to compensate.
    const { container, surface } = setup()
    surface.setPaintOffset(0.5)
    expect(container.style.top).toBe('-0.5px')
  })

  it('uses `top` rather than a transform', () => {
    // A fractional translate disables subpixel text antialiasing in Blink for the whole
    // subtree (crbug 573146) — and a sub-pixel carry is fractional by definition.
    const { container, surface } = setup()
    surface.setPaintOffset(0.25)
    expect(container.style.transform).toBe('')
    expect(container.style.top).toBe('-0.25px')
  })

  it('clears the offset at zero rather than writing -0px', () => {
    const { container, surface } = setup()
    surface.setPaintOffset(0.5)
    surface.setPaintOffset(0)
    expect(container.style.top).toBe('')
  })

  it('does not re-write an unchanged paint offset', () => {
    const { container, surface } = setup()
    surface.setPaintOffset(0.5)
    const spy = vi.spyOn(container.style, 'top', 'set')

    surface.setPaintOffset(0.5)
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

  it('enumerates the attached items, and stops as they detach', () => {
    // What the engine iterates to re-measure the rows still on screen after it discards the
    // size cache — the plural of `hasItem`, and the only enumerable key-to-element map there
    // is. A row that has detached must not appear: it has no box to read, and it is back on
    // its estimate honestly.
    const { surface } = setup()
    const first = item()
    const second = item()

    surface.attachItem('a', first)
    const detachSecond = surface.attachItem('b', second)
    expect([...surface.attachedItems()]).toEqual([
      ['a', first],
      ['b', second],
    ])

    detachSecond()
    expect([...surface.attachedItems()]).toEqual([['a', first]])
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
      surface.setLeadingSpace(100)
      surface.setTrailingSpace(50)
      surface.setPaintOffset(0.5)
      surface.setItemOffset('a', 10)
      surface.attachItem('a', document.createElement('div'))()
      surface.dispose()
    }).not.toThrow()

    expect(surface.hasItem('a')).toBe(false)
    expect(surface.focusItem('a')).toBe(false)
  })
})
