# 0017. Write tests that each protect a stated claim

- Status: Accepted
- Date: 2026-10-15

## Context

My earlier projects grew test suites into the thousands. Many tests duplicated coverage across layers, slowed every change and made refactors expensive without catching more bugs.

## Decision

Each test names the behavior or invariant it protects and runs at the lowest layer that can observe it. One claim is covered once. Time, IDs and randomness are injected. Storage tests use real SQLite on temp files. The full `pnpm verify` stays under five minutes. [Testing approach](../testing.md) has the layers, budgets and the challenge pack.

## Why

A fast, intentional suite gets run on every change. Each test that stays has a reason a reviewer can read in its name.

## Consequences

- Reviews reject tests that cannot state their claim, duplicate a lower-layer test, or snapshot large UI trees.
- Fakes prove controller decisions only. Live route claims need dated qualification runs.
