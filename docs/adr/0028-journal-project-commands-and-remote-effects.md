# 0028. Journal project commands and remote effects

- Status: Proposed
- Date: 2026-10-21

## Context

Daily coding needs project tests and builds, complete CI logs, branch publication and PR work. Local branch acceptance currently stops before push or deployment. Exposing an unrestricted renderer shell would bypass the controller's source, ownership and authority boundaries.

## Decision

I will add controller-owned operations for explicit executable/argv project commands and GitHub work. Each operation binds its working directory, source or commit, permitted environment, destination and effect authority. The existing owner records intent before spawn, captures output as immutable artifacts and proves process closure before reporting a successful terminal result. Missing closure retains unresolved ownership and an unknown outcome.

Read-only PR and CI retrieval stays separate from remote mutations. Push, PR changes, workflow dispatch, merge and deployment are distinct effects. Each requires authority for its concrete destination and action. An uncertain effect is reconciled by exact local or remote facts before retry. Reconnection never replays it automatically.

## Why

A second shell service would duplicate ownership, cancellation and recovery code. A raw terminal bridge would give display code authority it does not need. I chose the existing controller and process journals so commands share the same durable facts as checks and writers.

I will use installed Git and the existing configured GitHub CLI where they cover the operation. Credentials stay with those clients. Missing login, scope or tool identity produces a clear refusal and no account change.

## Consequences

- General project commands execute ordinary local code under the stated native trust profile in ADR 0009. Scratch isolation supplies no additional containment.
- Retained command output is evidence of that command. Trusted check evidence still needs its separately frozen evaluator and success criteria.
- Argument validation, bounded output pages and cancellation remain required even when a log or repository is large.
- Remote reconciliation must bind the exact repository, branch, commit and PR. A response timeout cannot justify a duplicate push or PR creation.
- [Daily-work slices](../daily-work-slices.md) separate read-only GitHub inspection, project commands and publication into independently testable releases.
