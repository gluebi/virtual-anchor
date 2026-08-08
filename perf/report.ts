/**
 * Turning frame records into numbers, and numbers into something readable.
 *
 * All statistics live here, in Node, rather than in the page: the recorder's per-frame cost is
 * one array store and it stays that way. Everything below is a pure function of a
 * {@link FrameRecord}, for the same reason `analyzeGestures` is pure — it makes the arithmetic
 * testable without a browser, and it means a saved JSON record can be re-analysed later without
 * re-running the benchmark.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FrameRecord } from './measure.js'

/** The median of a sample. Returns 0 for an empty one, which every caller treats as a failure. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

/**
 * The nearest-rank percentile of an **already sorted** ascending sample.
 *
 * Takes the sorted array rather than sorting per call: `summarise` wants three percentiles and a
 * maximum from the same 40,000-element sample, and a self-sorting `percentile` would copy and
 * sort it five times over. Sorting once also gives the maximum for free — `Math.max(...values)`
 * on a capacity-sized array spreads tens of thousands of arguments onto the stack, which is a
 * `RangeError` waiting on a knob nobody expects to be dangerous.
 */
function rank(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!
}

/** Ascending copy. One per sample, then indexed. */
function ascending(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b)
}

export interface Summary {
  /** Frames observed, which is `gaps.length` — see the note on {@link FrameRecord.gaps}. */
  frames: number
  elapsedMs: number
  /**
   * Frames per second over the recording.
   *
   * Derived from the gaps rather than from wall-clock, so it cannot disagree with the
   * percentiles beside it: both describe the same array.
   */
  fps: number
  p50: number
  p95: number
  p99: number
  longest: number
  /**
   * Percentage of the frames the display could have shown that were not drawn.
   *
   * A gap of two periods is one dropped frame, three is two, and so on — so this counts missed
   * opportunities rather than late callbacks, which is what "dropped" ordinarily means.
   */
  droppedPct: number
  /** Median milliseconds in the library's scroll handler. 0 when handler timing was not armed. */
  handlerP50: number
  handlerP95: number
  /** Scroll events seen. Zero here with a non-zero travel means the handler timing missed. */
  scrollEvents: number
  /** Total blocking time attributed by `long-animation-frame`. `null` where unsupported. */
  blockingMs: number | null
  overflowed: number
}

export function summarise(record: FrameRecord, periodMs: number): Summary {
  const { gaps } = record
  // One pass for both totals, rather than two traversals of the same array.
  let elapsedMs = 0
  let missed = 0
  for (const gap of gaps) {
    elapsedMs += gap
    missed += Math.max(0, Math.round(gap / periodMs) - 1)
  }
  const sortedGaps = ascending(gaps)
  const sortedHandler = ascending(record.handler)

  return {
    frames: gaps.length,
    elapsedMs,
    fps: elapsedMs === 0 ? 0 : (gaps.length * 1000) / elapsedMs,
    p50: rank(sortedGaps, 0.5),
    p95: rank(sortedGaps, 0.95),
    p99: rank(sortedGaps, 0.99),
    longest: sortedGaps.at(-1) ?? 0,
    droppedPct: gaps.length === 0 ? 0 : (missed / (gaps.length + missed)) * 100,
    handlerP50: rank(sortedHandler, 0.5),
    handlerP95: rank(sortedHandler, 0.95),
    scrollEvents: record.handler.length,
    blockingMs:
      record.loaf === null ? null : record.loaf.reduce((total, entry) => total + entry, 0),
    overflowed: record.overflowed,
  }
}

export interface Aggregate extends Summary {
  /** How many repetitions went into this row, after the warm-up was discarded. */
  runs: number
  fpsMin: number
  fpsMax: number
}

/**
 * Combine repetitions of the same cell.
 *
 * The median of each metric, except the two where the median is the wrong summary: `longest` and
 * `overflowed` take the worst across runs, because a single frame that blew the budget is a fact
 * about the library and averaging it away would be the harness lying on its behalf.
 */
export function aggregate(summaries: readonly Summary[]): Aggregate {
  if (summaries.length === 0) throw new Error('aggregate of no runs')
  const of = (pick: (summary: Summary) => number): number => median(summaries.map(pick))
  const rates = summaries.map((summary) => summary.fps)
  const blocking = summaries
    .map((summary) => summary.blockingMs)
    .filter((value): value is number => value !== null)
  return {
    runs: summaries.length,
    frames: Math.round(of((summary) => summary.frames)),
    elapsedMs: of((summary) => summary.elapsedMs),
    fps: median(rates),
    fpsMin: Math.min(...rates),
    fpsMax: Math.max(...rates),
    p50: of((summary) => summary.p50),
    p95: of((summary) => summary.p95),
    p99: of((summary) => summary.p99),
    longest: Math.max(...summaries.map((summary) => summary.longest)),
    droppedPct: of((summary) => summary.droppedPct),
    handlerP50: of((summary) => summary.handlerP50),
    handlerP95: of((summary) => summary.handlerP95),
    scrollEvents: Math.round(of((summary) => summary.scrollEvents)),
    blockingMs: blocking.length === 0 ? null : median(blocking),
    overflowed: Math.max(...summaries.map((summary) => summary.overflowed)),
  }
}

export interface Row extends Aggregate {
  motion: string
  dataset: string
  /** Whether the demo's own per-frame re-rendering was switched off with `quiet=1`. */
  quiet: boolean
  /** Anything motion-specific worth carrying into the report, e.g. a `ScrollResult`. */
  note?: string
}

const columns: { head: string; of: (row: Row) => string; width: number }[] = [
  { head: 'motion', of: (row) => row.motion, width: 12 },
  { head: 'dataset', of: (row) => row.dataset, width: 14 },
  { head: 'demo', of: (row) => (row.quiet ? 'quiet' : 'live'), width: 5 },
  { head: 'fps', of: (row) => row.fps.toFixed(1), width: 5 },
  { head: 'spread', of: (row) => `${row.fpsMin.toFixed(0)}-${row.fpsMax.toFixed(0)}`, width: 7 },
  { head: 'p50', of: (row) => row.p50.toFixed(1), width: 5 },
  { head: 'p95', of: (row) => row.p95.toFixed(1), width: 5 },
  { head: 'p99', of: (row) => row.p99.toFixed(1), width: 6 },
  { head: 'worst', of: (row) => row.longest.toFixed(1), width: 6 },
  { head: 'drop%', of: (row) => row.droppedPct.toFixed(1), width: 5 },
  { head: 'handler', of: (row) => row.handlerP50.toFixed(2), width: 7 },
  { head: 'hnd p95', of: (row) => row.handlerP95.toFixed(2), width: 7 },
  { head: 'events', of: (row) => String(row.scrollEvents), width: 6 },
  // Blank rather than "0" where the browser has no `long-animation-frame`, so an engine that
  // cannot report blocking time is not confused with one reporting none. On a clean 60 Hz run
  // this column is legitimately 0: LoAF does not report a frame until it crosses 50 ms, which is
  // why it is the last column and not the headline.
  {
    head: 'blocked',
    of: (row) => (row.blockingMs === null ? '—' : row.blockingMs.toFixed(0)),
    width: 7,
  },
]

/** A fixed-width table, because the report is read in a terminal. */
export function formatTable(rows: readonly Row[]): string {
  const line = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(columns[index]!.width)).join('  ')
  const head = line(columns.map((column) => column.head))
  const rule = '-'.repeat(head.length)
  const body = rows.map((row) => line(columns.map((column) => column.of(row))))
  return [head, rule, ...body].join('\n')
}

/**
 * The header that makes a number attributable.
 *
 * A frame time without the machine it was measured on is not a result, it is a rumour. The
 * measured period is included rather than the nominal refresh rate because it is the one that
 * every derived figure was actually computed against.
 */
export function formatHeader(context: {
  cpu: string
  browser: string
  periodMs: number
  build: string
}): string {
  const hz = context.periodMs === 0 ? 0 : 1000 / context.periodMs
  return [
    `machine   ${context.cpu}`,
    `browser   ${context.browser}`,
    `build     ${context.build}`,
    `display   ${context.periodMs.toFixed(2)} ms measured (${hz.toFixed(1)} Hz) — the ceiling for every fps below`,
  ].join('\n')
}

/**
 * What every table-shaped spec does at the end: print the report and save the record.
 *
 * One function rather than a copy per spec, because the two things it decides have to be decided
 * once. The **record format** is what a saved run is re-read with, and two definitions of it means
 * one reader cannot open both files. The **build string** is a claim about what was measured — if
 * a spec ever measures the instrumented build, this is the single place that has to stop saying
 * otherwise.
 *
 * The name prefixes the file, so a results directory says which spec produced what. Previously one
 * spec prefixed its records and the other did not.
 */
export function publish(options: {
  /** Prefixes the record file. Use the spec's own name. */
  name: string
  title: string
  rows: readonly Row[]
  periodMs: number
  browser: string
  /** Lines printed under the table — what the columns mean. */
  footer?: readonly string[]
}): void {
  const header = formatHeader({
    cpu: cpus()[0]?.model ?? 'unknown',
    browser: options.browser,
    build: 'demo production build (no library instrumentation)',
    periodMs: options.periodMs,
  })

  // eslint-disable-next-line no-console -- the report is the point of the run
  console.log(
    ['', options.title, '', header, '', formatTable(options.rows), '', ...(options.footer ?? []), ''].join(
      '\n',
    ),
  )

  const directory = join(dirname(fileURLToPath(import.meta.url)), 'results')
  mkdirSync(directory, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  writeFileSync(
    join(directory, `${options.name}-${stamp}.json`),
    JSON.stringify(
      { periodMs: options.periodMs, browser: options.browser, rows: options.rows },
      null,
      2,
    ),
  )
}
