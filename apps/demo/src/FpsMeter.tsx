import { useEffect, useRef } from 'react'

/**
 * A live frame-rate readout, for watching while you scroll.
 *
 * ## Why it does not use React state
 *
 * The number changes every frame, and a component that re-rendered to show it would re-render the
 * page on every frame of every scroll — which is the exact confound `CONFIG.quiet` exists to
 * remove (`config.ts`: "an ordinary fling re-renders the whole page on most frames… it is
 * indistinguishable, by feel, from the *library* stuttering"). An FPS meter that caused the jank
 * it displayed would be worse than none. So it writes `textContent` on a node it owns and React
 * never renders it again after mount.
 *
 * ## Why the display is slower than the measurement
 *
 * Every frame is counted; the text is rewritten four times a second. A number replaced sixty
 * times a second is unreadable, and the DOM write is the one part of this that is not free.
 * `worst` is the longest frame within each display window rather than an all-time high, so a
 * single hitch during page load does not sit on the readout forever — the interesting question
 * while scrolling is "is it hitching *now*".
 *
 * ## It perturbs what it measures
 *
 * One `requestAnimationFrame` callback per frame, the same cost the library's own frame probe
 * documents and offers `probe=0` to avoid (`frameProbe.ts:25`). `fps=0` turns this off for the
 * same reason, and the benchmark in `perf/` passes it — an instrument inside the thing being
 * measured is measuring itself.
 */
export function FpsMeter(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = ref.current
    if (node === null) return

    let handle = 0
    let last = 0
    let frames = 0
    let worst = 0
    let elapsed = 0

    const tick = (at: number): void => {
      handle = requestAnimationFrame(tick)
      // The first callback has no predecessor, so it contributes no interval — counting it would
      // put one made-up frame into the first window.
      if (last !== 0) {
        const gap = at - last
        frames++
        elapsed += gap
        if (gap > worst) worst = gap
        if (elapsed >= 250) {
          node.textContent = `${String(Math.round((frames * 1000) / elapsed))} fps · worst ${worst.toFixed(0)} ms`
          frames = 0
          worst = 0
          elapsed = 0
        }
      }
      last = at
    }

    handle = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(handle)
    }
  }, [])

  return (
    // Hidden from assistive technology on purpose: a number that changes four times a second is
    // noise in a screen reader, and nothing here is content.
    <div ref={ref} className="fps-meter" aria-hidden="true">
      measuring…
    </div>
  )
}
