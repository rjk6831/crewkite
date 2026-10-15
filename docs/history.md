# Design history

CrewKite went through six specification drafts in one week before any of this code existed. I keep the full working record private. This page keeps the decisions and the reasons, so anyone reading the ADRs can see how the design got here and which directions I ruled out.

## Lineage

| Draft | Date | Working name | What changed and why |
|-------|------|--------------|----------------------|
| 0.1 | 6 Oct 2026 | foreman, then SprAI | A Python prototype, about 1,000 lines with no dependencies. A local model planned and reviewed; the official coding clients ran headless in git worktrees. I wanted to prove local planning could save paid allowance. |
| 0.2 | 6 Oct 2026 | MomentumAI | I asked for one session where I pick the orchestrator, coders, reviewers, efforts, concurrency caps and review style across every provider I have, with automatic handoff when a budget threshold hits. An audit of 0.1 found its 17 tests passing while shared Git writes, unreviewed content and budget oversubscription went unchecked. The draft introduced a deterministic kernel and moved local models from premise to option. |
| 0.3 | 7 Oct 2026 | CrewKite | The draft drifted toward a general app builder for non-coders. I pulled it back to a coding war room: lead roles, an orchestrator, workers and an optional overseer, mixing local and subscription models. Reset-aware allocation became a core feature. I dropped the Python constraint so the stack could be chosen on evidence, and asked for ADRs. |
| 0.3 addendum | 9 Oct 2026 | CrewKite | I set the goal plainly: this becomes my first-choice daily interface for my own products. I set Breakaway as a design reference only, with no code copied. |
| 0.4 | 10 Oct 2026 | CrewKite | Six independent review perspectives (architecture, safety, providers, product, workstation, engineering) cross-checked the design. I selected TypeScript, React and Electron with a separate Node controller and SQLite. The usage dashboard, credit controls and local hardware card took shape. |
| 0.6 | 11 Oct 2026 | CrewKite | I cut the path to first use: D0 fake journey, D1a supervised native work, D1b checked results, D2 with all four route families, D3 distribution. Native client trust replaced a custom outer sandbox as a prerequisite. Authority, quality and effects became three independent controls. |
| 0.7 | 12 Oct 2026 | CrewKite | A competitive check showed routing, terminal persistence and context summaries already exist elsewhere. I reframed the value as a hypothesis to test with my own tasks, allowed one bounded adoption proof of an existing harness, and committed to a minimum core. |

There was no 0.5 draft. The build plan in this repository derives from 0.7.

## Directions I ruled out

| Direction | Where it came from | Why I dropped it |
|-----------|-------------------|------------------|
| Zero paid allowance for planning as a product rule | 0.1 | It optimized one cost and ignored completed work. Local planning stays an option to measure. |
| Keeping the Python prototype | 0.1 | It served as a probe. Its language and shared-worktree design were never commitments. Useful scenarios moved into the challenge pack. |
| Deferring parallel work to a later version | Early review of 0.2 | Bounded parallel slices are part of the product. Safety gates come first, then parallelism within limits. |
| A no-code builder or general research workspace | 0.3 drafting | It drifted from what I need. CrewKite is for coding. |
| Hiding expert controls behind a simple mode | 0.3 drafting | Role, model and effort choices are the point. They stay one interaction away from their summary. |
| Forking an existing agent desktop app by default | 0.3 and 0.4 | Inheriting a large codebase also inherits its authority model. Reuse is selective and recorded. |
| A framework tournament before building | 0.4 | I allowed one bounded adoption proof and closed the question. Repeated comparisons cost more than they return. |
| A custom outer sandbox before first use | 0.4 | It delayed a useful supervised workflow. The trust boundary is stated explicitly and stronger containment waits for a requirement that needs it. |
| Calling a two-provider demo the first release | 0.4 | I use four route families daily. A partial demo is an intermediate step. |
| Adopting a full routing gateway | 0.7 | Broad routing is available elsewhere. I may study specific pieces with provenance recorded. |

## Names

SprAI collided with existing sequencing software. MomentumAI collided with packages and AI businesses. I checked Maestro on 7 October and ruled it out because of several products with the same name in the same category. CrewKite is the working name. It has no trademark clearance yet, and I will get a proper review before any commercial launch.

## Credits

Three open-source projects shaped the review methods:

- [Ponytail](https://github.com/DietrichGebert/ponytail) for the simplicity lens and the build-less ladder in CONTRIBUTING.md
- [ADHD](https://github.com/UditAkhourii/adhd) for bounded assumption challenges during planning
- [multi](https://github.com/szarkans/multi) for independent and round-robin review

CrewKite implements its own versions of these methods as finite jobs. No code from them is copied.
