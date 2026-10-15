# 0004. Store control state in SQLite and artifacts as immutable files

- Status: Accepted
- Date: 2026-10-10

## Context

The controller must survive crashes without duplicating provider calls, and it must prove which exact content a check or review saw. The first prototype kept a JSON ledger.

## Decision

- SQLite current-state tables are authoritative. An ordered event log explains transitions.
- Large outputs, source snapshots and handoff packets are immutable files addressed by content hash.
- Prepared SQL, numbered forward migrations, foreign keys, WAL on local disk and full synchronous writes for control records.
- The prototype uses `node:sqlite` from the bundled Node runtime. I switch to a native module only if a required feature is missing.
- No ORM, no server database, no replay-only event sourcing.

## Why

This is a single-user local application. SQLite gives me real transactions for admission and a durable launch intent before every spawn. Content hashes make evidence identity cheap to check. Using the runtime's built-in SQLite removes a native build step from packaging.

## Consequences

- A consistent backup includes the referenced artifacts. Copying the live database alone is insufficient.
- Packaging records the exact SQLite version.
- Disk-full and corrupt-evidence paths keep the last valid state and raise an explicit blocker.
