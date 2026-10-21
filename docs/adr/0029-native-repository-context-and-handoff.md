# 0029. Own repository context and handoff in the controller

- Status: Proposed
- Date: 2026-10-21

## Context

A large repository cannot fit in one model request. This remains true when a provider advertises a large context window, because instructions, native client overhead, tool results and output all consume capacity. A Local model configured for 8K tokens makes the constraint easy to reproduce. Local inference remains optional under [ADR 0013](0013-macos-first-local-optional.md).

Repository chat products already index and retrieve code. Continue is a relevant implementation to study. I inspected its pinned revision [`5522c6f44ca0ac3528b37244818fbfa39b5af470`](https://github.com/continuedev/continue/tree/5522c6f44ca0ac3528b37244818fbfa39b5af470). Its [repository API](https://api.github.com/repos/continuedev/continue) reports `archived: false`, while the pinned [README](https://github.com/continuedev/continue/blob/5522c6f44ca0ac3528b37244818fbfa39b5af470/README.md) says the repository is unmaintained and read-only after the 2.0 release. Its [core](https://github.com/continuedev/continue/tree/5522c6f44ca0ac3528b37244818fbfa39b5af470/core) couples configuration, IDE write and command surfaces, secrets, global index state, native LanceDB, ONNX, Puppeteer and provider SDKs. Its `cn` CLI supplies no stable index or search RPC that fits CrewKite's controller boundary.

CrewKite already owns SQLite state and immutable artifacts under [ADR 0004](0004-sqlite-state-and-immutable-artifacts.md), durable recovery under [ADR 0007](0007-recover-from-durable-facts.md), and isolated candidates under [ADR 0008](0008-isolated-writers-local-branch-acceptance.md). [ADR 0027](0027-page-large-data-without-project-size-ceilings.md) separately proposes paged large-data boundaries. The existing review methods are finite jobs under [ADR 0011](0011-finite-review-methods.md). Their Ponytail, ADHD and multi influences remain recorded in [credits](../credits.md#review-methods-and-adapted-prose). They do not provide a repository context runtime.

## Decision

I will build repository context and provider handoff as a native controller subsystem. The controller owns the source and candidate epochs, indexed metadata, bounded reads, task graph, context budgets, durable facts, process journal, Stop behavior and handoff receipts. Models can propose searches, facts, work nodes and transitions. They cannot schedule their own unbounded loop, raise limits, approve effects or turn a statement into a verified fact.

The minimum vertical slice uses `node:sqlite` FTS5, the existing exact-search path and bounded file reads. Search rows bind a path, content hash, range and index version to one immutable source epoch. Candidate changes form a separate epoch. A stale result cannot enter a new request until the controller revalidates it.

Context turnover preserves constraints, decisions, open questions and evidence references outside the model window. A proposed fact records provenance, confidence, contradictions, supersession and check state. A file hash proves the cited bytes. It does not prove the model interpreted those bytes correctly.

Each provider adapter reports an honest capability envelope: observed model identity when available or unknown, configured and observed context limits, supported tokenizer or unknown, measured native overhead when available, tools, edit operations, cancellation and billing or quota evidence. Strict token-fit qualification requires supported tokenization and a complete measured envelope. Estimated byte or character counts use reserve headroom and recover cleanly from an upstream overflow.

The design must keep ordinary work available with one eligible configured route. Multiple routes are optional. Coordination value begins with two routes, either two cloud subscriptions or one cloud subscription plus Local. Three cloud subscriptions plus Local is a permitted target configuration. Local remains optional and is never an implicit fallback. CrewKite never moves work to a paid or cloud route silently. Process or model-family independence is reported separately under ADR 0011.

Handoff occurs at durable checkpoint or change-bundle boundaries. The recipient gets the exact source and candidate identities, current work graph, unresolved questions, evidence references, remaining limits and capability gaps. Its own consent, admission and qualification still apply.

## Why

I ruled out adopting Continue's whole core because its authority surfaces, process model, storage and dependency set conflict with the controller boundaries I already enforce. Adapting that core would make recovery and provider identity depend on a second configuration and index system. No Continue code is incorporated by this decision.

I also ruled out embeddings as a first requirement. FTS5, exact search and bounded reads can prove the end-to-end lifecycle without assuming that a chat model supplies embeddings or adding a vector runtime. I can add symbols, parsers or vectors after a benchmark identifies a retrieval failure they solve. Any later reuse follows [ADR 0016](0016-reuse-with-provenance.md): pin the exact revision and files, record dependencies and assets, review licenses and notices, document modifications and tests, assign update ownership, and add attribution.

This choice is useful only if it survives measurement. I will compare it with manual file selection and exact-search-only baselines. The proof set covers a multi-file bug fix, a feature, a cross-cutting consistency change, negative and no-op tasks, restart, Stop, stale source, provider handoff and recoverable context overflow. It records relevant-file recall, unrelated edits, turns, bytes, elapsed time, peak memory, duplicate submissions and retained receipts. Model semantic correctness remains a separate result from controller lifecycle correctness.

## Consequences

- The first delivery must close one path through preparation, retrieval, context turnover, candidate capture, check, review, local acceptance and reopen. More disconnected provider leaves wait.
- Provider differences remain visible. Unsupported delete, review or tool operations refuse. Missing tokenizer support forces estimated admission and blocks strict-fit qualification.
- Index migrations, stale epochs, contradictions and disk pressure need recovery tests.
- The existing isolated streamed primitive proof above 10,000 files and 64 MiB remains a regression case. It used offline fake-protocol children and is not shipped workflow qualification. A 20,000-file, 256 MiB fixture and a simulated 8K Local envelope are proposed next benchmarks. Passing controller checks makes no claim about general model quality.
- A public capability claim waits for offline proof, independent review and provider-specific user acceptance.
