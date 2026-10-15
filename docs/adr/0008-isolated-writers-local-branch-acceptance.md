# 0008. Isolate writers and accept results as new local branches

- Status: Accepted
- Date: 2026-10-06, delivery order revised 2026-10-11

## Context

The first prototype shared Git metadata between workers and could merge content that changed after tests ran. My checkout holds my uncommitted work, and nothing should touch it without my say.

## Decision

- Every writer works in an independent scratch copy of a selected committed base, without shared Git metadata, hooks or ambient configuration.
- Dirty and untracked files in my checkout are disclosed and preserved.
- Sealed work becomes an immutable candidate. Checks and reviews bind to its hash.
- Accepting a candidate creates one new local branch with create-if-absent semantics. It never overwrites a ref, merges, pushes or deploys.
- The first release runs one writer per task. Two parallel slices arrive with D2, behind a serialized integrator and a combined check.

## Why

Exact identity is what makes evidence mean something. A pass on one tree says nothing about a tree that changed by one byte. Creating a new branch is the smallest effect that delivers a usable result, and it is easy to inspect and discard.

## Consequences

- D1a ships manual export from scratch first. Checked branch acceptance follows in D1b.
- Editing a candidate creates a new identity and invalidates dependent evidence.
- Two slices that pass separately still need the combined check before acceptance.
