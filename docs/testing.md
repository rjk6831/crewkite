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

`pnpm verify` runs every layer except Package and must stay under five minutes on a laptop.

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

Each challenge maps to one integration test. A milestone claims only the challenges it actually runs.

## What fakes can and cannot prove

Fake providers prove controller decisions: admission, routing, recovery and evidence identity. They never prove that a live route authenticates, bills correctly or respects its tool boundary. Those claims need a qualification run on the real client, recorded with its date and version.
