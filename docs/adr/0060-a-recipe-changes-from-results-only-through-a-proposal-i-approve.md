# 0060. A recipe changes from results only through a proposal I approve and can revert

- Status: Proposed
- Date: 2026-11-18

## Context

A recipe is a file with recorded versions ([ADR 0057](0057-a-recipe-is-one-file-and-only-a-saved-version-runs.md)), and each step of each slice leaves a record ([ADR 0059](0059-results-stay-on-the-device.md)). With both in place, CrewKite could notice that a change to a recipe might help and say so.

Systems that edit their own setup go wrong in a familiar way. They change something, the next result looks better or worse for unrelated reasons, and nobody can tell which change did what. I set three conditions before a system may touch its own setup. Every part it can change is a file. Every change can be reverted. Every change comes with a prediction that later results either meet or miss.

This record states the rules for that step. Nothing in it is built.

## Decision

- CrewKite may later propose a change to a recipe from its recorded results. A proposal changes one field: the model of one role on the same provider, the effort of one role, or the slice limit.
- A proposal never touches the budget, the trigger, the permission policy, the flight mode, the handoff setting or the checks.
- A proposal shows four things: the change as a diff of the recipe file, the records it rests on, what it expects to happen as a number on a recorded figure, and how many later records it takes to check that.
- An example of an expectation: slices that pass the first review go from 12 of 20 to at least 16 of the next 20.
- No proposal is made from fewer than 20 recorded build steps on the recipe's current version, across at least 5 runs.
- Nothing changes without the person. An approved proposal is saved through the same save as any edit: the diff, a confirmation and a new recorded version.
- After the stated number of records, CrewKite compares the result with the expectation and shows both. When the expectation failed, it offers the revert to the earlier version. The revert is a save like any other.
- A recipe has at most one open proposal. No new one is made until the open one is checked or withdrawn.
- The controller computes a proposal from counts. No model decides one, and none approves one ([ADR 0002](0002-authority-in-deterministic-code.md)).
- Proposals, expectations and their outcomes stay on the device with the records.

## Why

One field at a time is what makes a result readable. If a proposal changed the builder and the reviewer together, a better pass rate would not say which change earned it.

I ask for the expectation first because a change with no prediction can be read as a success whatever happens. A number written before the runs can be checked against them.

I keep the limits and gates out of reach, and a model change stays on its provider because another provider would need a new limit in the budget. A budget, a permission and a check exist to bound what a run may do. A system that could loosen its own bounds because its numbers looked good would be approving its own work, which is the thing ADR 0002 rules out.

The minimum of 20 build steps across 5 runs is a floor. It claims no significance. Below it the counts move with a single odd request, and a suggestion that one more run reverses is worse than no suggestion.

The person approves every change because the recipe spends their allowance on their code, and a count cannot tell what they wanted from a run.

## Consequences

- Most recipes will see no proposal for weeks. That is expected at these counts.
- An expectation can fail for reasons that have nothing to do with the change, such as harder requests. The comparison shows the numbers and offers the revert. It does not explain the cause.
- Each proposal needs the records to carry the recipe version, which they do.
- Building this needs its own contract for proposals and their outcomes, and a screen. Neither exists yet.
