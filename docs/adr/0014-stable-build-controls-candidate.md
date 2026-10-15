# 0014. Develop CrewKite with a stable build that controls a candidate build

- Status: Accepted
- Date: 2026-10-11

## Context

I plan to build CrewKite with CrewKite. A bad change to the controller, policy or evaluator could take away my ability to stop work or recover it.

## Decision

- An installed stable build (A) controls work on candidate source (B).
- B gets its own state, socket and profile. It defaults to fake providers and never inherits live credentials.
- Promotion is a separate decision: freeze hashes, test B in isolated state, back up A's state with its artifacts, stage B, boot without dispatch and require a health check before resuming.
- A recovery path inspects, stops, exports and reopens tasks without a model call, a rebuild or a download.
- The controller runs in the foreground and starts on demand. A background service comes later.

## Why

Improving the tool must never cost me the ability to recover my work. Candidate code must never grade itself.

## Consequences

- An incompatible older build refuses read-write access and offers export.
- A rollback never restores an old ledger that forgets later calls, branches or denials.
- Before self-development becomes my default, I run a drill: disable the candidate and recover through the installed path.
