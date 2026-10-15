# 0010. Separate authority, quality and effects in task policy

- Status: Accepted
- Date: 2026-10-11

## Context

Fewer interruptions and lower quality are different choices. A single autonomy dial ties them together, so asking for fewer prompts quietly drops checks.

## Decision

Task policy has three independent axes:

| Axis | Choices | Meaning |
|------|---------|---------|
| Authority | Guided, Balanced, Autopilot | Which checkpoints ask me |
| Quality | Quick, Standard, Thorough | Which checks and reviews are required |
| Effects | Named finite grants | Which consequential actions are permitted |

Every authority preset starts at Standard quality. Autopilot grants no destination, paid call or acceptance by itself. An optional local acceptance grant permits exactly one new local branch for a named task, with an expiry, and stays revocable.

## Why

I want to choose how often I am interrupted without lowering the evidence bar. Keeping effects separate means no preset can push, merge or spend by accident.

## Consequences

- The controller stores the fully resolved policy with a hash. Reusing a profile never reuses its authorization.
- The UI shows only controls the route can enforce. Edited presets become Custom.
- CrewKite's own source, billing, privacy and release protections have no Off switch.
