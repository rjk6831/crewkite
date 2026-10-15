# 0012. Deliver in milestones D0 through D3 with a minimum core

- Status: Accepted
- Date: 2026-10-11, minimum core added 2026-10-12

## Context

Earlier drafts gated first use on a full sandbox, three adapters and an acceptance pipeline. That pushed a useful tool weeks out.

## Decision

- D0: the packaged desktop and CLI journey against fake providers.
- D1a: one qualified official client doing supervised work with manual export.
- D1b: checked results and local branch acceptance.
- D2: local, OpenAI, Anthropic and Google routes with handoff, honest usage and two-slice parallel work.
- D3: distribution for a stated audience.

Every new mechanism must serve an enabled requirement or remove demonstrated work. One integration owner lands contracts, migrations, the lockfile and entry points.

## Why

Each milestone makes one claim I can test, and D1a puts a real patch in my hands early. A small core is cheaper to keep correct.

## Consequences

- I publish outcomes and exits. Dates wait for measured throughput.
- Diagrams, ingestion, analytics and team infrastructure never gate first use.
- See the [roadmap](../roadmap.md) for packets W0 to W12.
