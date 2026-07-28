import { faker } from '@faker-js/faker'

export interface Comment {
  id: string
  index: number
  author: string
  postedAt: string
  body: string[]
}

/** Total comments in the simulated thread — more than fits in memory comfortably. */
export const THREAD_SIZE = 12_000

/** Comments delivered per page load, at either end. */
export const PAGE_SIZE = 40

/**
 * A deterministic thread, so a Playwright run and a manual look see the same
 * text and the same heights.
 *
 * Lengths are deliberately lopsided: mostly a paragraph or two, occasionally an
 * essay several times the height of the viewport. That last case is what makes an
 * item-fraction visibility rule unsatisfiable and the viewport-fraction rule
 * necessary.
 */
export function buildThread(): Comment[] {
  faker.seed(20260728)

  return Array.from({ length: THREAD_SIZE }, (_, index) => {
    const roll = (index * 37) % 100
    const paragraphs = roll < 60 ? 1 : roll < 85 ? 2 : roll < 97 ? 4 : 14

    return {
      id: `comment-${String(index)}`,
      index,
      author: faker.person.fullName(),
      postedAt: faker.date.past({ years: 2 }).toISOString(),
      body: Array.from({ length: paragraphs }, () => faker.lorem.paragraph()),
    }
  })
}

/** Latency for a simulated page fetch, in ms. */
export const FETCH_LATENCY = 120

export interface Window {
  /** Index of the first loaded comment. */
  from: number
  /** Index after the last loaded comment. */
  to: number
}

/**
 * The window a thread opens on: a page centred on the target comment.
 *
 * This is the real product behaviour — a thread opens where you left off, not at
 * the top — and it is what makes an index-addressed model painful, because the
 * loaded slice grows at both ends and every index shifts.
 */
export function initialWindow(targetIndex: number): Window {
  const half = Math.floor(PAGE_SIZE / 2)
  const from = Math.max(0, targetIndex - half)
  return { from, to: Math.min(THREAD_SIZE, from + PAGE_SIZE) }
}

export function extendUp(current: Window): Window {
  return { ...current, from: Math.max(0, current.from - PAGE_SIZE) }
}

export function extendDown(current: Window): Window {
  return { ...current, to: Math.min(THREAD_SIZE, current.to + PAGE_SIZE) }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
