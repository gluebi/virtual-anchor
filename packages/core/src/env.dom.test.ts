import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  devicePixelRatioOf,
  isIOSWebKit,
  prefersReducedMotion,
  supportsScrollEnd,
} from './env.js'

/**
 * Impersonate a device by overriding the navigator/window bits we read.
 *
 * `defineProperty` rather than `vi.spyOn`, because jsdom's navigator has no
 * `maxTouchPoints` property at all — there is nothing to spy on.
 */
const patched: string[] = []
const pretend = (options: {
  userAgent?: string
  platform?: string
  maxTouchPoints?: number
  touch?: boolean
}): void => {
  const values: Record<string, unknown> = {
    userAgent: options.userAgent ?? '',
    platform: options.platform ?? '',
    maxTouchPoints: options.maxTouchPoints ?? 0,
  }
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(navigator, name, { configurable: true, get: () => value })
    patched.push(name)
  }

  if (options.touch) {
    Object.defineProperty(window, 'ontouchend', { configurable: true, value: null })
  } else {
    Reflect.deleteProperty(window, 'ontouchend')
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const name of patched) Reflect.deleteProperty(navigator, name)
  patched.length = 0
  Reflect.deleteProperty(window, 'ontouchend')
  Reflect.deleteProperty(window, 'onscrollend')
})

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const MAC_UA = IPAD_DESKTOP_UA
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

describe('isIOSWebKit', () => {
  it('detects an iPhone', () => {
    pretend({ userAgent: IPHONE_UA, platform: 'iPhone', maxTouchPoints: 5, touch: true })
    expect(isIOSWebKit()).toBe(true)
  })

  it('detects an iPad that claims to be a Mac', () => {
    // Since iPadOS 13 the iPad sends a desktop user agent and reports MacIntel,
    // so a naive /iPad/ test misses every modern iPad. Touch points are the only
    // thing that separates it from a real Mac.
    pretend({
      userAgent: IPAD_DESKTOP_UA,
      platform: 'MacIntel',
      maxTouchPoints: 5,
      touch: true,
    })
    expect(isIOSWebKit()).toBe(true)
  })

  it('does not match a desktop Mac', () => {
    pretend({ userAgent: MAC_UA, platform: 'MacIntel', maxTouchPoints: 0 })
    expect(isIOSWebKit()).toBe(false)
  })

  it('does not match a touch-capable Mac without touch events', () => {
    pretend({ userAgent: MAC_UA, platform: 'MacIntel', maxTouchPoints: 5, touch: false })
    expect(isIOSWebKit()).toBe(false)
  })

  it('does not match a Windows touch laptop', () => {
    pretend({ userAgent: WINDOWS_UA, platform: 'Win32', maxTouchPoints: 10, touch: true })
    expect(isIOSWebKit()).toBe(false)
  })

  it('detects Chrome on iOS, which is WebKit underneath', () => {
    pretend({
      userAgent: `${IPHONE_UA} CriOS/131.0.0.0`,
      platform: 'iPhone',
      maxTouchPoints: 5,
      touch: true,
    })
    expect(isIOSWebKit()).toBe(true)
  })
})

describe('supportsScrollEnd', () => {
  it('reports true when the event exists', () => {
    Object.defineProperty(window, 'onscrollend', { configurable: true, value: null })
    expect(supportsScrollEnd()).toBe(true)
  })

  it('reports false when it does not', () => {
    Reflect.deleteProperty(window, 'onscrollend')
    expect(supportsScrollEnd()).toBe(false)
  })
})

describe('prefersReducedMotion', () => {
  it('follows the media query', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
    } as unknown as MediaQueryList)
    expect(prefersReducedMotion()).toBe(true)
  })

  it('defaults to false when the query does not match', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
    } as unknown as MediaQueryList)
    expect(prefersReducedMotion()).toBe(false)
  })

  it('defaults to false where matchMedia is unavailable', () => {
    // jsdom does not implement `matchMedia` at all, so this captures `undefined` —
    // which is the point. `Reflect.get` rather than a property read because the latter
    // is an unbound-method reference as far as the linter is concerned.
    const original: unknown = Reflect.get(window, 'matchMedia')
    Reflect.deleteProperty(window, 'matchMedia')
    expect(prefersReducedMotion()).toBe(false)
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: original })
  })
})

describe('devicePixelRatioOf', () => {
  it('reads the ratio from a window', () => {
    expect(devicePixelRatioOf({ devicePixelRatio: 2.625 } as Window)).toBe(2.625)
  })

  it('falls back to 1 for a missing or nonsensical ratio', () => {
    expect(devicePixelRatioOf(null)).toBe(1)
    expect(devicePixelRatioOf(undefined)).toBe(1)
    expect(devicePixelRatioOf({ devicePixelRatio: 0 } as Window)).toBe(1)
    expect(devicePixelRatioOf({ devicePixelRatio: -1 } as Window)).toBe(1)
    expect(devicePixelRatioOf({} as Window)).toBe(1)
  })
})
