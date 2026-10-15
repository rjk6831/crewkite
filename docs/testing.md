# Testing approach

Every test in this repository protects a claim I would otherwise have to defend by hand. I keep the suite small, fast and deliberate. A test that cannot name the claim it protects gets deleted.

## Rules

- Name each test after the behavior or invariant it protects, in plain words.
- Test at the lowest layer that can observe the claim. A rule in a pure function gets a unit test.
- Cover one claim once. When a lower layer proves a rule, higher layers exercise the wiring only.
- Use table-driven cases when one rule has several inputs that matter. Prefer one test with a case table over ten near-copies.
- Inject time, IDs and randomness. No sleeps, no wall-clock waits, no network.
- Use real SQLite on a temp file for storage claims. Avoid mocking code from this repository.
- Keep fixtures synthetic. Real secrets never appear in canary files.

I skip tests for trivial getters, framework behavior, type-only code and markup snapshots. Large UI snapshots break on every polish pass and prove little.

## Layers

| Layer | Proves | Tools | Budget |
|-------|--------|-------|--------|
| Domain | Routing, admission math, state transitions, policy resolution, packet integrity | Unit tests with injected clock and IDs | Whole layer under 5 seconds |
| Controller | Intents, receipts, restart reconciliation, disk-full, idempotency against real SQLite | Integration tests on temp directories | Under 20 seconds |
| Fakes | Fragmented or oversized streams, duplicates, hung turns, stubborn children | Executable fake providers from `packages/testkit` | Inside the controller budget |
| Interface | One journey through desktop and CLI on the same task, keyboard path, hostile output stays inert | Playwright driving Electron, CLI in a subprocess | Under 2 minutes |
| Package | Installed app finds its runtime, survives removal of the source tree | Manual or scheduled on macOS hardware | Per release |

`pnpm verify` must stay under five minutes on a laptop. The current suite has 25 tests: five policy tests, two contract tests, seven allocation and continuity tests, four client and CLI tests, and seven controller tests. It also runs lint, types and the desktop build. The desktop journey and installed-package checks remain pending.

The controller tests cover mutation retries and changed-key rejection, stale revisions, intent-before-spawn recovery, retained descendants, candidate evidence identity and local publication. The full flow uses a manual check approval, reserve transfer, real Node checks and two scripted review jobs. It verifies a new branch over several source ancestors, an immutable patch, unchanged sentinels and index bytes, and an inert clean-filter canary. Pending-action cancellation and export approval preserve coherent task state.

The fixed synthetic check definition requires the original test file and its expected file-qualified completions. Added tests cannot substitute for those assertions. Skips, early import exits, incomplete reports and a changed evaluated copy fail the evidence boundary. Arbitrary repository checks are unqualified.

## The challenge pack

One synthetic repository anchors the integration tests. Its task adds `netMinor(subtotalMinor, discountMinor)`: accept non-negative safe integers in minor units, clamp the discount at the subtotal, expose the result through the CLI and the UI. 3000 and 500 give 2500. 3000 and 4000 give 0. Negative and non-integer inputs are rejected.

The repository also carries staged, unstaged, untracked, binary and executable sentinel files. They must survive every scenario unchanged.

| Challenge | Required outcome |
|-----------|------------------|
| Desktop and CLI switch | Same task, revision and approvals. A duplicate start launches once |
| No final summary | Saved edits and criteria survive. The partial report stays unverified |
| Crash around launch | The intent reconciles. An ambiguous call is never replayed |
| Unknown writer | A resistant child blocks sealing, takeover and cleanup |
| Cross-route handoff | Safe stop. Criteria, denials, artifacts and liability carry over |
| Billing uncertainty | An ambient key or paid alias blocks the route. No API fallback |
| Stale usage | Unknown and reset-pending stay visible. No inferred refresh |
| Changed evidence | A one-byte edit or a smaller test collection invalidates the prior pass |
| Combined failure | Two passing slices that disagree on a field name fail the combined check |
| Publication crash | The exact ref reconciles once. Conflicts are never overwritten |

The challenge table is the acceptance plan. The current suite covers the named controller subset above. It does not claim disk-full recovery, a crash after ref creation, billing qualification or the desktop journey from the build alone.

## What fakes can and cannot prove

Fake providers prove controller decisions: admission, routing, recovery and evidence identity. They never prove that a live route authenticates, bills correctly or respects its tool boundary. Those claims need a qualification run on the real client, recorded with its date and version.
