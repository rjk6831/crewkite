# 0059. Results stay on the device

- Status: Proposed
- Date: 2026-11-18

## Context

I can see what a turn cost and how long it took. I cannot see what a setup produced. Nothing records whether the reviewer found the builder's slice clean the first time, how many fix rounds a slice took, or whether I accepted the result. A review verdict is a line in a message, a plan lane is dropped when its slice merges, and a thread keeps only its newest check runs.

Without those facts I compare two crews by memory. Any later step where CrewKite suggests a change to a setup would have no record to rest on.

## Decision

- The controller writes one record per step of a plan: build, review, fix, merge and resolve for each slice, and the challenge and the closing report for the plan as a whole. A retried slice and a second plan on the same thread get records of their own.
- A record holds the recipe and its version hash for the plan a recipe run started ([ADR 0057](0057-a-recipe-is-one-file-and-only-a-saved-version-runs.md)). A later plan on that thread is my own follow-up and carries no recipe. A record also holds the step, the role, the provider, the model, the effort, the writing-rules version, the design-system version, the first check result, the first review verdict, the fix rounds, what became of the changes, the duration and the allowance used.
- A value the controller did not observe is stored as unknown, and nothing later replaces it with a guess. Two values arrive after the step: the final state moves from waiting to what the person decided, and the allowance used is written once, when the reading after the step comes in.
- Allowance used is stored only where a reading stood on both sides of the work, on the same window, with no other chat turn on that provider inside CrewKite in between. The reading after a step is the first one the usual usage reads bring. A step that gets none within fifteen minutes stays unknown, so steps that run back to back on one provider mostly read unknown. A task run, and use of the same account outside CrewKite, cannot be seen, and the figure can include either. A run reads allowance once at its start and once at its end. Recording adds no provider call.
- Records live in the local database. Nothing is uploaded and there is no telemetry.
- An export writes the records as JSON to a place the person chooses.
- Allowance used never adds across providers or windows. A percent of one window is a different unit from a percent of another ([ADR 0006](0006-route-by-allowance-and-reset-windows.md)).
- The results view shows counts per recipe and per role and model: slices run, how many passed the first review, average fix rounds, the share accepted and allowance used. It shows counts only. It does not rank setups or suggest a change.
- A record outlives its thread and its recipe.

## Why

The records name my models, my timings and how often my reviewer disagreed with my builder. That is my working data, and it stays where the rest of my state is ([ADR 0004](0004-sqlite-state-and-immutable-artifacts.md)). Uploading it would need consent screens, a retention policy and a server to keep it on. I do not want to run any of those for a feature that works on one machine.

I store unknown as unknown because these records are evidence. A duration I guessed or a verdict I inferred from a later message would read the same as one the controller saw, and every later comparison would inherit the guess.

The view stops at counts. Early on a recipe has a handful of runs on different requests. A ranking built on six slices would be noise with a number on it, and people would act on it. Counts let me read the data without being told what it means.

## Consequences

- Results do not follow me to another machine. A wiped home loses them unless I exported them.
- Allowance used is often unknown, because a reading has to stand close to both ends of the work.
- Records start with this version. Earlier threads have none.
- A record's final state says waiting until I accept or discard the thread's changes.
- These records are the base for [ADR 0060](0060-a-recipe-changes-from-results-only-through-a-proposal-i-approve.md). That record builds nothing yet.
