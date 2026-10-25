# Architecture decision records

Each record states one decision, the context that forced it, why I chose it and what it costs. I write them in first person because I make and own these calls. A decision changes only through a new record or a dated amendment to an existing one, with the evidence that justified the change.

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](0001-coding-workspace-for-daily-projects.md) | Build a coding workspace for my daily projects | Accepted |
| [0002](0002-authority-in-deterministic-code.md) | Keep authority in deterministic code | Accepted |
| [0003](0003-typescript-electron-node-controller.md) | Use TypeScript, React and Electron with a separate Node controller | Accepted |
| [0004](0004-sqlite-state-and-immutable-artifacts.md) | Store control state in SQLite and artifacts as immutable files | Accepted |
| [0005](0005-official-clients-on-user-subscriptions.md) | Connect only through official clients on the user's own subscriptions | Accepted |
| [0006](0006-route-by-allowance-and-reset-windows.md) | Route work by remaining allowance and reset windows | Accepted |
| [0007](0007-recover-from-durable-facts.md) | Recover tasks from durable facts, without a final model summary | Accepted |
| [0008](0008-isolated-writers-local-branch-acceptance.md) | Isolate writers and accept results as new local branches | Accepted |
| [0009](0009-native-client-trust-profile.md) | Trust official clients natively in the first release | Accepted |
| [0010](0010-independent-authority-quality-effects.md) | Separate authority, quality and effects in task policy | Accepted |
| [0011](0011-finite-review-methods.md) | Run review methods as finite jobs with credit | Accepted |
| [0012](0012-milestones-d0-to-d3.md) | Deliver in milestones D0 through D3 with a minimum core | Accepted |
| [0013](0013-macos-first-local-optional.md) | Start on Apple Silicon macOS with local inference optional | Accepted |
| [0014](0014-stable-build-controls-candidate.md) | Develop CrewKite with a stable build that controls a candidate build | Accepted |
| [0015](0015-neutral-public-history.md) | Keep public history neutral and the working record private | Accepted |
| [0016](0016-reuse-with-provenance.md) | Reuse open source only with recorded provenance | Accepted |
| [0017](0017-tests-protect-stated-claims.md) | Write tests that each protect a stated claim | Accepted |
| [0018](0018-apache-2-license.md) | License CrewKite under Apache 2.0 | Accepted |
| [0019](0019-transport-seam-for-team-and-remote.md) | Defer team, remote and hosted features behind a transport seam | Accepted |
| [0020](0020-profiles-resolve-to-finite-gates.md) | Resolve profiles to finite effect gates and bounded reviews | Proposed |
| [0021](0021-explicit-route-order-and-review-floors.md) | Resolve explicit route order and minimum review methods | Proposed |
| [0022](0022-attested-billing-for-supervised-pilots.md) | Separate observed billing facts from supervised pilot attestations | Proposed |
| [0023](0023-qualify-provider-eligibility-before-release.md) | Qualify provider eligibility before release | Proposed |
| [0024](0024-integrate-google-through-its-published-acp-agent.md) | Integrate Google through its published ACP agent | Proposed |
| [0025](0025-use-an-explicit-memory-only-local-credential.md) | Use an explicit memory-only Local connection credential | Proposed |
| [0026](0026-bind-combined-acceptance-to-checked-origins.md) | Bind combined acceptance to checked contributor origins | Proposed |
| [0027](0027-page-large-data-without-project-size-ceilings.md) | Page large data without aggregate project-size ceilings | Proposed |
| [0028](0028-journal-project-commands-and-remote-effects.md) | Journal project commands and remote effects | Proposed |
| [0029](0029-native-repository-context-and-handoff.md) | Own repository context and handoff in the controller | Proposed |
| [0036](0036-the-chat-thread-is-the-product-center.md) | Make the chat thread the product center | Proposed |
| [0037](0037-push-and-pull-requests-from-the-changes-tab.md) | Push and open pull requests from the Changes tab | Proposed |
| [0038](0038-crew-and-flight-modes.md) | Run a crew in a thread, with flight modes and four handoff modes | Accepted |
| [0039](0039-attachments-follow-each-client.md) | Send each attached file the way its client takes it | Accepted |
| [0040](0040-accept-from-the-thread-base.md) | Accept from the thread's base, whatever HEAD is | Accepted |

## Writing a new record

Copy this outline into the next number. Keep it under a page.

```markdown
# NNNN. Decision in plain words

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context

What forced the decision. Facts and constraints only.

## Decision

What I chose, stated so someone could check the code against it.

## Why

The reasons, in first person, including the alternatives that lost.

## Consequences

What this costs, what it rules out and what has to happen next.
```

Anyone can propose a record. Only I move one to Accepted.
