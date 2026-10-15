# 0016. Reuse open source only with recorded provenance

- Status: Accepted
- Date: 2026-10-09, sources updated 2026-10-12

## Context

Good open-source work exists for cooldown tracking, reset parsing, terminal lifecycle and agent UIs. Reuse can save weeks. Untracked reuse imports legal and security debt.

## Decision

Before incorporating anything, I pin the exact revision, list the files, dependencies and assets taken, check the license and notices, and record modifications, tests and who owns updates. Specific sources:

| Source | License | Use |
|--------|---------|-----|
| DeepSeek Harness | MIT | One bounded adoption proof (ADR 0003) or isolated components |
| OmniRoute | MIT | Study its cooldown tracker and reset parser; persist results in my controller |
| herdr | Apache 2.0 | Lifecycle lessons, narrowly reviewed code |
| Archify | MIT | Later diagram validation, without its brand assets |
| OpenMontage | AGPL 3.0 | No code without a separate license decision |
| Breakaway | PolyForm Noncommercial | Design reference only. No code copied |

## Why

Recorded provenance lets me ship notices correctly, answer license questions quickly and remove a component cleanly.

## Consequences

- A code license never grants service access, subscription capacity or trademarks.
- Visible source is not a reuse grant.
- Nothing from this list is incorporated today.
