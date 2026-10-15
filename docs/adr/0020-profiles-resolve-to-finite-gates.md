# 0020. Resolve profiles to finite effect gates and bounded reviews

- Status: Proposed
- Date: 2026-10-16

## Context

I want reusable goals and principles without leaving consequential actions implicit. A review switch also needs an execution limit and evidence of what actually ran. ADRs 0010 and 0011 keep authority separate from quality and bound review work.

## Decision

I resolve a profile to concrete policy before a run. Goal and principle text supplies instructions. It grants no authority. Each named effect either asks me for its exact action or carries a task-bound, expiring, one-use grant.

A pending approval retains its exact task revision, attempt, generation, target and payload. Approval permits that one action after the controller rechecks ownership, source, limits and current authority. Waiting for approval creates no launch intent. An unknown writer blocks execution.

Keep it simple, Challenge assumptions, Second opinion and Round-robin review are optional methods. Each selected method names a reviewer role and one to three cycles. Jobs share the run's attempt and minute limits. Evidence binds method, cycle, route and immutable candidate identity. Missing, truncated or blocked output cannot pass. D0 results identify themselves as scripted.

## Why

I need to inspect what a preset permits before starting it. A visible Ask control needs a resolvable action. Bounded jobs let me choose the review cost and see whether the selected methods ran.

## Consequences

- Edited profiles resolve to a new frozen policy. Reusing a profile never reuses authorization.
- A write-scratch grant allocates one bounded run workspace. Successors still pass admission and prove the prior writer stopped.
- Check approval belongs to its exact attempt and candidate effect. Byte-identical candidate evidence can remain valid; changed content needs fresh authority and evidence.
- Team roles are optional until selected work needs them. D0 keeps one writer per task under ADR 0008.
- Controller and interface work must enforce these gates before the controls claim that behavior.
