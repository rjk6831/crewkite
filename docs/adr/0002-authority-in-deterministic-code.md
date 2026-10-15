# 0002. Keep authority in deterministic code

- Status: Accepted
- Date: 2026-10-07

## Context

Agent harnesses often let model output steer permissions, budgets or task state. The first prototype let a failed worker reach approval and let budgets oversubscribe. I want to leave work running and trust what happened while I was away.

## Decision

One controller owns permissions, budget admission, task ownership, evidence identity and result acceptance. Models, including the orchestrator and the optional overseer, propose plans, assignments, edits and recovery steps. No client, provider or UI path bypasses the controller.

## Why

A prompt cannot enforce anything. Deterministic code can be tested, replayed from recorded inputs and audited after the fact. The controller keeps enforcing limits even when every model is unavailable.

## Consequences

- Routing is a pure function of recorded inputs, and every decision stores its reasons.
- The overseer role is advisory. It can flag a stalled task or suggest a route, and the controller decides.
- Every dispatched job counts against limits: reviews, repairs, summaries, advisor calls and local generations.
- A per-action approval control exists only where the route exposes an enforceable boundary.
