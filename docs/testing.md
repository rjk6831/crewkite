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
| Controller | Intents, receipts, restart reconciliation, disk-full, idempotency against real SQLite | Integration tests on temp directories | Under 3 minutes |
| Fakes | Fragmented or oversized streams, duplicates, hung turns, stubborn children | Executable fake providers from `packages/testkit` | Inside the controller budget |
| Interface | One journey through desktop and CLI on the same task, keyboard path, hostile output stays inert | Playwright driving Electron, CLI in a subprocess | Under 2 minutes |
| Package | Installed app finds its runtime, survives removal of the source tree | Manual or scheduled on macOS hardware | Per release |

`pnpm verify` must stay under five minutes on a laptop. The current suite has 40 tests: five policy tests, two contract tests, seven allocation and continuity tests, four client and CLI tests, eleven controller tests, two source claims, eight provider claims, and one desktop journey. It also runs lint, types and the desktop build. CI runs the full suite natively on macOS 15 with Chromium sandboxing enabled. Linux desktop startup remains unqualified. Installed-package recovery remains a separate check.

Two controller claims connect the native owner to retained artifacts and patch export with the same scripted protocol fixture used at the provider boundary. They cover private appointments and public preparation through the same owner, frozen source and task text, exact saved consent, profile and credit revalidation, submission uniqueness, Stop and restart. Blocked preparation changes no run, route or task revision. Repeated previews reuse bounded profile routes; separate tasks retain their own writer leases. The tables also cover phase ownership, deadline and stale-source refusal, awaited cleanup and uncertain application receipts. The retained-proposal table prepares candidate evaluation with separate grants and reviewer consent, runs the trusted synthetic Node checks, and retains passing or failing evidence without automatic review or acceptance. Its explicit review rows bind a fresh native job to the successful check and unchanged candidate, refuse exhausted grants or changed authority, and retain process-only evidence without applying files. They cover active replay, Stop after submission, awaited shutdown and restart without another submission. The table also covers saved preparation across restart, duplicate check starts, and Stop, expiry or consent revocation after intent before the local child launches. The evidence claim rejects a changed frozen check definition. Its historical comparison accepts an identical reporter at a new absolute location and rejects changed digests, reporter bytes, evaluator, arguments, test scope, criteria, required tests or candidate. Pending execution keeps the exact definition. These checks spend no inference and establish no arbitrary project-check or native qualification.

The provider claims use fixed transcripts and scripted child processes to check metadata projection, request and attempt correlation, bounded replacement output and owned cleanup. The fixtures establish no native account, billing or route readiness.

The retained-proposal table also checks the shared evaluation preview. Repeated reads create no receipts, artifacts or intents. Changed grants, consent, checks or reviewer support make Start unavailable; completed evidence survives later expiry. The preview reports the remaining original run budget. Start commands still enforce their own guards.

The existing acceptance claim also covers one native candidate using the same scripted protocol fixture. Real local checks and a matching native review precede a destination-bound local approval. Changed candidate bytes, check identity, review job, output binding or phase proof block publication. Expired inference consent and a withdrawn provider profile preserve historical evidence. Changed source blocks approval consumption and missing-ref recovery. Same-key replay and restart create no extra submission, preserve conflicting refs and verify an exact existing branch. The original checkout, index and sentinel modes stay unchanged. This is offline evidence; live native acceptance remains unverified.

The controller tests cover mutation retries and changed-key rejection, stale revisions, guarded replacement of unstarted drafts, intent-before-spawn recovery, retained descendants, candidate evidence identity and local publication. The full flow uses a manual check approval, reserve transfer, real Node checks and two scripted review jobs. It verifies a new branch over several source ancestors, an immutable patch, unchanged sentinels and index bytes, and an inert clean-filter canary. The source inspection claim bounds filenames by rows and encoded bytes while preserving full counts. It checks special files and filter inertness once at the source boundary. The replacement table rejects changed manifests and unsupported target files before writing, then checks exact truncation and preserved permissions on success. The routing table covers ordered and reset-aware selection against the same hard gates. The same acceptance claim covers reserve and manual transfer. Manual transfer preserves a healthy primary pin, honors a pause during stop, retains its target across restart without dispatch, and rechecks that target on explicit resume. Pending-action cancellation and export approval preserve coherent task state.

The desktop journey uses the real Electron main, sandboxed preload, renderer, socket and controller. It creates and prepares one task, approves the first gate, observes a reserve handoff, kills the controller during retained work, restarts the same home and resumes explicitly. A CLI review approval appears in the GUI's recorded evidence. Real Node checks and two scripted reviews precede acceptance into a new branch. Exported bytes match the artifact checksum, and the original checkout, index and sentinel modes remain unchanged. The path includes keyboard activation, theme changes and inert hostile output. The same journey then prepares and starts a single-file native proposal using an explicitly injected scripted profile and the shared provider fixture. It checks the default credit choice, explicit consent renewal, unchanged hidden grants, retained changes and export, and unavailable resume and route switching. Acceptance stays disabled before matching evidence. Separate evaluation preparation starts no attempt. Explicit local checks precede one scripted native-protocol review, with reviewer credits off by default. The native candidate then uses a destination-bound local approval to create its exact checked branch. The journey verifies its parent and content, preserves the original source, index and prior branch, and reopens accepted state with unchanged evidence and attempt counts. Desktop cleanup requires normal application close and an observed zero, unsignaled child exit within ten seconds; forced cleanup fails the claim. The journey launches no native provider.

The existing CLI table covers all three evaluation commands, frozen candidate and preparation bindings, separate consent and default-off credit choices, invalid grants and retained evidence. Local acceptance binds the current candidate, revision and destination, reports pending approval and preserves exact uncertain receipt retries. Plain review text escapes terminal control characters. Ordinary task output keeps its existing shape.

A separate live pilot on 16 October 2026 used normal desktop task creation, native preparation and Start with the supported OpenAI profile. The CLI inspected and exported the retained single-file candidate. The original source and index stayed unchanged, all native groups were absent, and the same home reopened without another submission. A later no-provider directory-package proof displayed that task and its exact changes. The packaged CLI replayed the applied export receipt to a new file and saved the same 610-byte patch. Task state, artifacts, scratch and immutable package assets stayed unchanged, and the owned desktop and controller closed. This proves completed-task reopen for that profile and runtime. Active crash recovery, tool containment and billing after included usage remain separate gates.

A later live proof started from a fresh Mac directory package and used its normal desktop-owned controller. One desktop-created task retained a replacement and a 610-byte export after 41.816 seconds. The packaged CLI exported it, and the same home reopened without another submission. Original source, index and sentinels stayed unchanged, all three native groups were absent, both desktop-owned controllers exited, and immutable package assets stayed unchanged. Together with useful real-file work and the earlier Stop proof, this completes the bounded D1a workflow. The [provider notes](providers.md) record its exact profile and remaining limits. Installer recovery remains unverified.

Automated export selects a destination through the native dialog API in the test process. Native OS picker and save interaction need a manual check. Screenshots come from the desktop journey and a separate connected capture script. They make no assertion about visual correctness.

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

The challenge table is the acceptance plan. The current suite covers the named controller subset above. It does not claim disk-full recovery, a crash after ref creation, billing qualification or installed-package recovery. Native OS dialogs remain separate from automated dialog selection.

## What fakes can and cannot prove

Fake providers prove controller decisions: admission, routing, recovery and evidence identity. They never prove that a live route authenticates, bills correctly or respects its tool boundary. Those claims need a qualification run on the real client, recorded with its date and version.
