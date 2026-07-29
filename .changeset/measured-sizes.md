---
'virtual-anchor': patch
---

State the measured bundle size on the npm page.

Minified and brotlied, including zustand: 8.34 kB for the core entry and 9.96 kB if you import
the React adapter, which contains the core rather than duplicating it — the two entries share a
chunk. Both numbers are enforced as CI budgets, so the README cannot drift from what ships.

This is also the first release published through npm trusted publishing: no token exists, and
the tarball carries a provenance attestation linking it to the commit and workflow that built
it.
