# 0021. Resolve explicit route order and minimum review methods

- Status: Proposed
- Date: 2026-10-16

## Context

A list of approved backups needs a visible order I can rely on. The reset-aware router in ADR 0006 can choose a later route when its allowance expires sooner. Quality also needs a clear minimum so a preset cannot hide which review work it requires.

## Decision

I propose a saved selection rule for each role. Ordered selection chooses the first eligible primary or fallback in my list. Reset-aware selection keeps the existing reset preference and tenure rules. Legacy roles without a selection field retain reset-aware behavior. Both modes enforce pins, every applicable allowance window and the remaining budgets before selection.

New policy resolution uses these method floors, in dispatch order:

| Quality | Required methods |
|---------|------------------|
| Quick | Keep it simple |
| Standard | Keep it simple, Second opinion |
| Thorough | Keep it simple, Second opinion, Challenge assumptions |

Declared checks stay required. Second opinion needs the Reviewer role. Advisor can supply a simplicity or assumption lens, with no independent-review claim. Reviews on the writer's route or provider family establish process independence only. Each selected method retains its own cycle cap and candidate-bound evidence.

New Round-robin selection waits for an explicit ordered panel of review assignments. Permission to substitute a fallback never authorizes running every backup. Max audit remains deferred until that panel has meaningful execution and evidence. Existing frozen policies keep their exact assignments.

## Why

I want the launch card to explain both the route choice and the review cost. An explicit rule preserves the existing reset workflow and gives deliberate backup order a precise meaning. Simplicity runs before the independent review spends its allowance.

## Consequences

- Editing a never-started preview creates a new frozen run, retains history and requires explicit start. Pending work or uncertain ownership blocks editing.
- A new Quick run needs an eligible review role and one additional bounded job. Saved limits never increase silently.
- Speed support belongs to an exact qualified catalog variant, separate from effort. Missing metadata leaves Fast unavailable and establishes no new route qualification.
- No preset changes billing authority, publication permission or the evidence required for acceptance.
