/**
 * Two decimal places, for numbers a human is going to read.
 *
 * Shared because it was written inline four times — three in `frameProbe.ts` and twenty in
 * `analyzer.ts` — and a report where one field is rounded and its neighbour is not reads as a
 * measurement artefact rather than as formatting.
 *
 * Deliberately *not* `snapToDevicePixels(n, 100)` from `anchor.ts`, which is byte-identical
 * arithmetic. That helper is documented as being "used only at the point of writing a visual
 * offset to the DOM", and passing it a device pixel ratio of 100 to mean "two decimals" would
 * misstate what the call is for. Two functions, same maths, different meanings.
 */
export const round = (n: number): number => Math.round(n * 100) / 100
