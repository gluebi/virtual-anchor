---
'virtual-anchor': minor
---

Instrument the fling, and make the instrumentation free when it is off.

This ships measurement, **not a fix**. A fling on iOS jumps, stutters and sometimes stops
abruptly while slow scrolling is perfect, and the reason it was not already diagnosed is that
every tool for diagnosing it was broken in a different way. Four of those, each verified against
the source or the shipped artifact rather than reasoned about:

**The instrumentation was compiled out of the build under test.** `TRACING` was
`process.env.NODE_ENV !== 'production'`, and a phone is served a production build. `setTraceSink`
returned `false`, the demo's overlay printed "tracing is compiled out of this build", and there
was nothing to read. Running a dev server instead is not the answer: dev-mode React and
`StrictMode`'s double invoke are themselves a source of jank, which makes them a confound when
the symptom *is* smoothness.

**`deferred` meant *wanted*, not *did*.** In `writeScroll` the flag was computed, and traced,
before the test that decides whether the write actually happens — `Math.abs(held) <= room`, forty
lines further down. So a correction that escaped because the bank's bound fired was recorded as
`deferred: true`, and the demo's on-device readout printed it as `DEFER`. That readout's own
comment said the case was "worth naming rather than leaving to be inferred from a WRITE among
DEFERs", and then named it as its opposite — while it is the leading suspect for the abrupt stop.
`scroll.write` now carries `reason` (`held`, `gate-open`, `model`, `no-room`) and `took`, keyed on
the *gate* rather than on the intent. Keying on intent is not merely less informative but wrong:
`deferred` is already `false` for a model change, so a prepend overriding a shut gate reported
`gate-open` and looked like an ordinary write on an idle platform. The type checker caught that as
an impossible comparison.

**There was a second writer, entirely untraced.** `scroller.ts` writes `scrollTop` and emitted
nothing; `scroll.step` says the convergence loop *ran*, which is not the same claim. The overlay
filtered on `scroll.write`, the engine's door. Every conclusion of the form "no write escaped
during that gesture" was drawn from half the writers. It now emits `scroll.commit`, plus
`scroll.park`, `wake` and `flush`, which together make "the parked loop woke and wrote during
momentum" legible.

**And the instrument perturbed the experiment.** The `scroll.write` thunk called
`contentOffset()` and then `getScrollOffset()` twice more inside `room` — three forced synchronous
layouts per traced write, in a thunk that runs after `publish` has written styles, on the hottest
path in the library. On a gesture this file's own comments record at 43 deferrals, that is 129
layouts that existed only because someone was watching. The values are now hoisted and the thunk
reads nothing.

Four more of the same kind went with it, three of them found by reviewing this change rather than
the code it replaced. `anchor.restore` and `measure.batch` dropped their `scrollOffset` field, which
`scroll.sample` now reports at higher fidelity anyway. `scroll.start` had one inside its thunk, and
the write two lines below it read the same value again. And the new `scroll.commit` had reintroduced
the defect in the sibling module: once per convergence frame, and once on the gate-open path — which
runs immediately after a style write, making it a *guaranteed* forced layout at the exact moment a
fling ends. `write()` now takes the offset its caller already holds. An engine-level test asserts
that a traced measurement performs the same number of scroll-offset reads as an untraced one.

`reconcileGestureShift` — the fold of a banked correction back into `scrollTop`, and the most
plausible cause of a visible jump — emitted nothing at all. Worth knowing when reading a trace:
the fold *is* a `scrollTop` write, and it is deliberately not a `scroll.write`, because it is not a
correction — it is a correction already taken being converted from a paint offset back into a real
offset. Three topics therefore account for every write the library makes: `scroll.write` from the
engine, `scroll.commit` from the scroller, and `gesture.fold`. An e2e assertion reconciles all three
against a patched `scrollTop` setter, which is what stops the trace from quietly disagreeing with
the platform.

The event carries `clamped`, which tests an invariant the function's own doc comment asserts cannot
be violated: `room` was checked per deferral against an offset the fling has since moved, so by the
time the fold lands its target may sit past the maximum. Precisely because the invariant is asserted
in prose, nothing would have reported it broken.

Also new: `scroll.sample` (every scroll event, stamped at *delivery*, so the inter-arrival gap is
not contaminated by the handler's own duration), `paint.offset` (which of the two addends moved the
container), `gate.attach` (emitted *before* the off-iOS early return, because otherwise "the gate
stayed idle" and "there is no gate on this platform" are the same observation — and off iOS every
correction writes unconditionally), `measure.done` with a duration, and `layout.signature`, whose
strings name which term moved and so separate a URL bar collapsing from a webfont landing.

### What is new for a consumer

`addTraceListener(fn)` returns an unsubscribe and composes, so your own listener and the debug
overlay can coexist. `setTraceSink` is unchanged in signature, return value and replace-the-last
semantics; it simply no longer evicts listeners it did not install, which no correct caller could
have depended on. The demo was the proof that one slot was not enough: it installed a ring buffer
and then replaced it with a HUD that re-implemented the buffer by hand.

`virtual-anchor/debug` is a new entry point — a trace recorder, a frame probe, a touch probe, an
on-page readout, and a **pure** `analyzeGestures` that ranks the ways a fling is known to be able
to misbehave and says which one the recording shows. It prints a verdict to the console as each
gesture settles. Every hypothesis has a unit-test fixture that must produce it and a second that
must not; that second half caught a confident false positive during development, reporting a
permanent anchor displacement where the trace showed a quarter of a pixel.

`trace` is now generic over its topic, checked against a map of payload shapes. That is not
ceremony: the analyzer reads payloads by field name from several modules away, so a renamed field
would leave everything compiling and the diagnosis silently empty. Turning the map into a
constraint immediately found that eight emitted topics were missing from it, that `scroll.start` was
sending a possibly-`undefined` key where its declaration promised one, and that `frame.long` was
spreading in a field it never declared. The gate's `state` and `reason` are unions rather than
`string` for the same reason — they are what segmentation keys on.

### What it costs when off

Less than before. The default entry is **9.7 kB** brotlied, down from 10.24 kB, and the React
entry 12.07 kB from 12.56 kB — because the topic strings and guards now actually vanish, where
previously about 2 kB of them shipped. `scripts/check-package.mjs` greps the published artifact and
fails the build if a single topic string survives, so the claim is enforced rather than stated.

The reason it did not work before is worth recording, because a doc comment in this package
asserted the opposite and a reader may have relied on it. It blamed minifiers for not propagating a
module-level constant across modules. What actually happens is narrower: esbuild's bundler prints
every top-level `const` as `var`, so the shipped chunk read
`var TRACING = process.env.NODE_ENV !== "production"` and a `var` is not a constant. The const-ness
was destroyed by this package's own build, before any consumer's minifier saw the file — so no
consumer-side configuration could ever have recovered it, and the fold has to happen here.
`minifySyntax` in `tsup.config.ts` is what enables it, and it costs nothing in readability because
the existing Rollup pass re-prints.

`virtual-anchor/debug` ships only if imported, so a consumer who never writes that import ships
none of it. Both facts have size budgets in CI.

### Turning it on

Off by default. To keep the instrumentation in a *production* build, resolve the new `development`
export condition — one line of resolver config, and the README has it per bundler. Your app stays a
production build: React 19 ships no `development` condition, so nothing about this flips React.

The published tarball grows, because two builds ship: 412 kB, of which `dist/dev` is 668 kB of the
1,464 kB unpacked — mostly source maps. That is a download-once cost for whoever installs the
package; what a consumer *bundles* went down, which is the number in the section above.

An export condition rather than an alias, deliberately: a condition switches the whole export map
at once, so the package cannot be half-switched into two module instances — which is the same
hazard the ESM-only decision exists to prevent, since the trace sink is module state.

### What it found

Two defects, both on a real device, both now fixed under their own changesets: the momentum gate's
ceiling cutting off every fling longer than three seconds, and a model change during momentum
writing the fling's own lag. Neither was the mechanism predicted before there was any data — that
was `overscroll-write`, which never fired once. The second was found by a consumer reading a
recording this produced, which is the case the toolkit was built for.

`overscroll-write` remains ranked and unobserved: `writeScroll` consults `writeGate.canWrite()` but
never `writeGate.isActive()`, whose only caller is the scroller, so nothing applies the rubber-band
refusal on the engine's path. It stays in the table because the reasoning still holds and the signal
is now recorded if it ever happens.
