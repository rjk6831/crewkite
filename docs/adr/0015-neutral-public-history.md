# 0015. Keep public history neutral and the working record private

- Status: Accepted
- Date: 2026-10-10, enforcement added 2026-10-15

## Context

I design and build CrewKite with several AI coding tools, and CrewKite itself orchestrates them. Each tool has its own habits: branch prefixes, authoring trailers, instruction files, comment styles. My planning record includes long specifications, prompts and conversations that belong in my private notes.

## Decision

- The repository holds code, first-person documentation and ADRs. Specifications, prompts, handoffs and transcripts stay in a git-ignored `internal/` folder and never enter history.
- Branches follow `<type>/<kebab-topic>` from a fixed list of types. Commits follow Conventional Commits.
- Commits carry no tool authorship trailers. Agent product names appear only under `providers/`, where the product integrates with them.
- Instruction files for local tools stay untracked.
- `scripts/policy.mjs` enforces all of this in git hooks and as the first CI job. The list of agent names lives in a repository variable.

## Why

CrewKite treats every provider equally, so its repository favors none of them. History should read as one engineering voice with clear decisions, whichever tool produced a first draft. I review and own every change that lands.

## Consequences

- Allowlists do most of the work: branch types, root files and dot folders. The checks reject unknown patterns without naming any tool.
- Necessary provider identifiers and third-party notices stay where they belong.
- Before the repository goes public, I review retained refs, artifacts and history for private material.
