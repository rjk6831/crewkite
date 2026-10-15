# 0011. Run review methods as finite jobs with credit

- Status: Accepted
- Date: 2026-10-06, naming revised 2026-10-07

## Context

Three open-source methods improved my results: a simplicity lens from Ponytail, assumption challenges from ADHD, and independent and round-robin review from multi. Installing each as a separate harness is fiddly, and their playful names hide what they do.

## Decision

CrewKite implements its own versions as bounded jobs on the same scheduler: Keep it simple, Challenge assumptions, Second opinion and Round-robin review. Each has a cycle cap, counts against limits and credits its source project. Each job ends when its cap is reached. No method runs as a permanent agent, and there is no general debate engine.

## Why

Clear names make the controls usable without memorizing a skill catalog. Bounded jobs keep cost predictable and let me measure whether each method helps.

## Consequences

- A missing, malformed, truncated or abstaining review never counts as approval.
- Two reviewers from the same model family count as process independence only.
- Repairs and re-reviews consume reserved allowance.
