# Roadmap

I deliver CrewKite in milestones that each make one claim I can test. Dates follow measured progress, so this page lists outcomes and exits.

## Milestones

| Milestone | Outcome | Exit evidence |
|-----------|---------|---------------|
| D0 Packaged fake journey | Desktop, CLI, transport and storage share task IDs through start, approvals, stop, restart, changes and export, with scripted fake providers | The journey runs end to end on the packaged app. Fakes prove mechanics only |
| D1a Supervised native work | One qualified official client works in scratch. I can inspect activity and approvals, stop truthfully, keep an edit, reopen it and export it | A real patch from one of my projects that is worth reopening the next day |
| D1b Checked dogfood | Immutable candidates, independent checks and review, acceptance as a new local branch | A checked result branch with its evidence receipt |
| D2 Daily-driver release 0.1 | Qualified OpenAI, Anthropic, Google and Local routes in useful roles, durable handoff, honest usage, finite review, two coding slices with a combined check, safe self-development | Ten real tasks from my own backlog, observed end to end |
| D2b User acceptance and corrections | Real-work UAT, final testing and required fixes before distribution | User acceptance and final testing pass, required fixes are verified, and I explicitly approve starting D3 |
| D3 Distribution | Package provenance, install, recovery, compatibility, notices, privacy and signing for a stated audience | A clean install on a machine that never saw the source tree |

D1a is complete for the bounded OpenAI single-file profile. It supports an existing committed text file. A useful documentation task produced a retained patch. Later synthetic tasks passed normal desktop and fresh package launch, CLI export and same-home reopen. Stop retained interrupted work without applying it. The original source stayed unchanged. The Anthropic single-file pilot recorded launch, export, Stop and same-home reopen with explicit subscription-login and disabled-extra-usage confirmations. Its local native path remains available under the existing admission checks. Prior Google pilots recorded those mechanics without establishing current integration permission. Google consumer automatic launch is unavailable under its published integration policy. [Provider routes](providers.md#current-availability) records the dated boundaries and historical evidence. Manual native file handoff has [offline fixture coverage](continuity.md#manual-native-file-handoffs) with explicit recipients and fresh consent. Connected transfer, general live routing and local inference remain unqualified. Local acceptance follows the separate D1b evidence and permission path. The [CLI setup](../apps/cli/README.md#native-single-file-runs) describes the available OpenAI and Anthropic preparation and manual export.

D1b is complete for one useful CrewKite repository task. A live OpenAI writer removed redundant completed check and review controls from the evaluation view. The Mac directory package ran all six fixed verification stages and all 40 tests against that immutable candidate. A fresh native review passed with zero findings and same-family process independence only. A separate destination-specific approval created the exact checked result on the local `feat/evaluation-outcomes` branch. The same home reopened with its branch and evidence intact, without another submission. The original checkout and index stayed unchanged. This meets the checked-result exit above. The recipe requires a matching registered source checkout with installed development dependencies and Electron. A separate live OpenAI repository Stop retained interrupted work through same-home reopen. Full profile qualification remains pending. D2's ten real tasks, broader routing and handoff remain open. D3 still requires a clean install on a machine that never saw the source tree.

The primary conversation with a lead that plans work and coordinates workers remains under implementation. The current desktop uses task forms and an activity feed. The conversation must retain questions, decisions and task context through normal use; the controller continues to own permissions, budgets and acceptance under [ADR 0002](adr/0002-authority-in-deterministic-code.md). This is part of the daily workspace in [ADR 0001](adr/0001-coding-workspace-for-daily-projects.md) and remains a D2 requirement.

A two-provider demo is an intermediate step on the way to D2. Google remains in the four-family target through the separate ACP proposal. The consumer headless writer stays blocked. The [bounded ACP workflow](providers.md#google-acp-writer) has import and setup controls, with production launch unavailable until its pinned review-mode and edit-tool mappings are verified. It still needs eligibility, authentication, billing and native behavior evidence before qualification. A quota read supplies no coding authority. [Proposed ADR 0023](adr/0023-qualify-provider-eligibility-before-release.md) and [Proposed ADR 0024](adr/0024-integrate-google-through-its-published-acp-agent.md) await acceptance; Accepted ADR 0012 remains unchanged.

I will pause after D2 for real-work user acceptance and final testing. D2b holds any required corrections and their verification. I will explicitly approve the move to D3 after this gate passes.

## Work packets

| Packet | Outcome | Exit |
|--------|---------|------|
| W0 | Shared contracts and the reference fixture | Agreed command, event and state contracts |
| W1 | Native account, policy and billing premise for the first route | Six pilot checks recorded, or a named blocker |
| W2 | Durable engine with finite limits | Restart never duplicates an ambiguous launch |
| W3 | Packaged desktop and CLI cockpit | The D0 fake journey |
| W4 | Real scratch edit, retain and export | A useful D1a task |
| W5 | Candidate, checks, review, local branch | D1b |
| W6 to W8 | Eligible Anthropic, Google and Local routes | Per-route qualification |
| W9 | Continuity without a summary, usage controls | Ownership and budgets preserved across a handoff |
| W10 | Two coding slices with a combined check | A combined failure blocks acceptance |
| W11 and W12 | My D2 release, user acceptance, then distribution | The D2 exit, D2b acceptance and explicit approval for D3 |

After W4, packets W5 through W9 run alongside each other against stable interfaces. One owner lands schema, migration, lockfile and entry-point changes. There are never concurrent migrations or competing schedulers.

## Later

These stay out of the first build. Each one gets its own gates when I enable it:

- Team accounts, remote and mobile clients, a hosted control plane
- A full editor or language server integration
- Arbitrary agent swarms and a plugin marketplace
- A permanent background service and automatic updates
- A CI helper for user projects: inspect workflows, explain cost and coverage, propose a candidate patch on request
- Platforms beyond macOS, each with its own writer qualification

## How I will judge it

I measure usable results, my active minutes, elapsed time including waits, and the context I had to rebuild by hand. I record abandoned work and every time I chose another tool. If CrewKite keeps adding overhead, I fix the specific friction first, then narrow scope. Adding providers or features is not the default answer.

Quantitative claims about advantage wait for a comparative study of 30 to 50 tasks with failures and exclusions disclosed.
