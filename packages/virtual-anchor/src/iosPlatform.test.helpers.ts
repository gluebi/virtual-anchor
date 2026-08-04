/**
 * Impersonating iOS WebKit, for the suites that test the momentum write gate.
 *
 * Shared because `isIOSWebKit()` reads four separate signals, and three copies of the
 * impersonation meant a fifth signal could be added to the sniff while two `.ios.`
 * suites silently carried on testing the *non*-iOS path — passing, and worthless.
 *
 * Not a `.test.ts` file: the name keeps it out of both vitest `include` globs so it is
 * never collected as a suite, while the `.test.` segment keeps it out of the coverage
 * `include`. See `vitest.config.ts`.
 */

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const patched: string[] = []

/** Make `isIOSWebKit()` return true. Call from `beforeEach`. */
export const pretendIPhone = (): void => {
  const values: Record<string, unknown> = {
    userAgent: IPHONE_UA,
    platform: 'iPhone',
    maxTouchPoints: 5,
  }
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(navigator, name, { configurable: true, get: () => value })
    patched.push(name)
  }
  Object.defineProperty(window, 'ontouchend', { configurable: true, value: null })
}

/** Undo {@link pretendIPhone}. Call from `afterEach`, or mid-test to go back off iOS. */
export const unpretendIPhone = (): void => {
  for (const name of patched) Reflect.deleteProperty(navigator, name)
  patched.length = 0
  Reflect.deleteProperty(window, 'ontouchend')
}

/** Dispatch a bare touch event, which is all the gate's listeners look at. */
export const touch = (
  element: HTMLElement,
  type: 'touchstart' | 'touchend' | 'touchcancel',
): void => {
  element.dispatchEvent(new Event(type))
}
