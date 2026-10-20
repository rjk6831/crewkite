# Roadmap

I deliver CrewKite in milestones that each make one claim I can test. Dates follow measured progress, so this page lists outcomes and exits.

## Milestones

| Milestone | Outcome | Exit evidence |
|-----------|---------|---------------|
| D0 Packaged fake journey | Desktop, CLI, transport and storage share task IDs through start, approvals, stop, restart, changes and export, with scripted fake providers | The journey runs end to end on the packaged app. Fakes prove mechanics only |
| D1a Supervised native work | One qualified official client works in scratch. I can inspect activity and approvals, stop truthfully, keep an edit, reopen it and export it | A real patch from one of my projects that is worth reopening the next day |
| D1b Checked dogfood | Immutable candidates, independent checks and review, acceptance as a new local branch | A checked result branch with its evidence receipt |
| D2 Daily-driver release 0.1 | Qualified OpenAI, Anthropic, Google and Local routes in useful roles, durable handoff, honest usage, finite review, two coding slices with a combined check, safe self-development | Ten real tasks from my own backlog, observed end to end |
| D2b Daily-work scale and acceptance | Large repositories, files and context; local Instant History; optional older-history compression; practical multi-file and GitHub/CI work | A representative real-project acceptance matrix passes at scale, including interruption, recovery and cross-version reopen |
| D2c Optional stabilization | UAT corrections and remaining stabilization identified after D2b | Required corrections are verified; this milestone is used when observed issues need it |
| D3 Distribution | Package provenance, install, recovery, compatibility, notices, privacy and signing for a stated audience | A clean install on a machine that never saw the source tree |

D1a is complete for the bounded OpenAI single-file profile. It supports an existing committed text file. A useful documentation task produced a retained patch. Later synthetic tasks passed normal desktop and fresh package launch, CLI export and same-home reopen. Stop retained interrupted work without applying it. The original source stayed unchanged. The Anthropic single-file pilot recorded launch, export, Stop and same-home reopen with explicit subscription-login and disabled-extra-usage confirmations. Its local native path remains available under the existing admission checks. Prior Google pilots recorded those mechanics without establishing current integration permission. Google consumer automatic launch is unavailable under its published integration policy. [Provider routes](providers.md#current-availability) records the dated boundaries and historical evidence. Manual native file handoff has [offline fixture coverage](continuity.md#manual-native-file-handoffs) with explicit recipients and fresh consent. Connected transfer and general live routing remain unqualified. Useful bounded Local work is recorded separately below. Local acceptance follows the separate D1b evidence and permission path. The [CLI setup](../apps/cli/README.md#native-single-file-runs) describes the available OpenAI and Anthropic preparation and manual export.

D1b is complete for one useful CrewKite repository task. A live OpenAI writer removed redundant completed check and review controls from the evaluation view. The Mac directory package ran all six fixed verification stages and all 40 tests against that immutable candidate. A fresh native review passed with zero findings and same-family process independence only. A separate destination-specific approval created the exact checked result on the local `feat/evaluation-outcomes` branch. The same home reopened with its branch and evidence intact, without another submission. The original checkout and index stayed unchanged. This meets the checked-result exit above. The recipe requires a matching registered source checkout with installed development dependencies and Electron. A separate live OpenAI repository Stop retained interrupted work through same-home reopen. Full profile qualification remains pending. D2's ten-task evidence is recorded below. Broader routing and handoff retain their stated limits. D3 still requires a clean install on a machine that never saw the source tree.

The primary conversation now retains messages, questions, answers and proposed plans. Explicit adoption saves the task contract without starting execution. Planning uses the supported profile and finite task budget; selected committed source and explicit project logs are captured as immutable context. The controller owns permissions, budgets and acceptance under [ADR 0002](adr/0002-authority-in-deterministic-code.md). This implements part of the daily workspace in [ADR 0001](adr/0001-coding-workspace-for-daily-projects.md); it establishes no autonomous coordination or planning-route qualification.

Primary planning now saves supported model and effort requests from a successful turn's last-observed catalog. The next admitted turn validates the requested pair again. Future execution policy opens an explicit preparation draft and leaves existing execution policy frozen. These controls preserve read-only planning, cumulative task limits and separate grants.

D2 requires qualified routes across all four families, a useful qualified Local role and operation with Local disabled, durable approved handoffs, honest usage, finite independent review, useful two-slice work with a combined check, and safe self-development. On 2026-10-20, ten distinct real backlog outcomes completed their original checks, separate native review, destination acceptance and same-home reopen. The record includes useful bounded Local work and one two-slice outcome with its combined check and whole-parent review. The release receipt binds the exact routes, candidate source and separate verification and package observations. General live routing and unobserved provider operations retain their stated limits. Real-project D2b acceptance and required corrections remain pending; I will explicitly approve any D3 start.

The bounded combined workflow implements two scoped child writers, one shared budget, checked ordered replay and a separate full check and review of the final candidate. Immutable contributor origins and guarded private ref updates prevent passing slices from bypassing the combined barrier. Offline fixtures cover controller mechanics, parent controls and interrupted ownership. A supervised two-slice documentation task completed baseline checks, both writers, ordered replay, the combined check and whole-parent review, followed by branch acceptance and same-home reopen. It used the fixed project Node recipe and process independence only. That combined task counts once among the ten outcomes. Broader provider qualification and real-project user acceptance keep their separate gates.

I chose the separate ACP profile for Google's coding path in D2. The consumer headless writer stays blocked. The [bounded ACP workflow](providers.md#google-acp-writer) binds its production review-mode and edit-tool mappings to one exact imported bundle. Personal-account authentication and configuration discovery have completed through normal setup. A useful bounded coding task completed its original checks, separate review, destination acceptance and same-home reopen. Its record identifies the exact client, selected configuration and permission actions actually observed. Active task Stop and installed recovery remain unverified without their own dated proof. The default-on quota read supplies no coding authority. [Proposed ADR 0024](adr/0024-integrate-google-through-its-published-acp-agent.md) records this decision; Accepted ADR 0012 remains unchanged.

I am preparing the candidate around normal registered projects and supported provider connections. Explicit developer fixtures remain useful for controller tests, but none count as a real backlog task or live qualification. A source commit, verification receipt or package build alone does not complete D2.

## D2b daily-work acceptance

D2b is planned work after the D2 UAT candidate. I will define a representative daily-work acceptance matrix before claiming this scope is complete:

- Handle large files, repositories and context through streaming, pagination, segmented reads, backpressure and indexed retrieval. Remove arbitrary product-size ceilings while keeping finite message framing and resource accounting. Provider context windows remain real constraints; context assembly and compaction must make those limits explicit.
- Add local Instant History for the conversation, task, tool, attachment and result history CrewKite actually receives. Use indexes, segmented reads and UI virtualization for fast task opening and scrolling without a network round trip. Measure cold and warm large-history latency. Separate cloud-app conversations and server-only data remain outside that access.
- Offer an optional mode that compresses older history sections independently, with a configurable age threshold. Keep indexes and recent content readily available, decompress requested sections in the background and cache nearby sections. Preserve every retained section and its integrity; measure latency and storage gains.
- Support practical multi-file edits, commands, diffs, tests, Git branch, commit and push, and GitHub CLI (`gh`) workflows. Include PRs and GitHub Actions/CI status and logs in the normal task workflow, with clear authority, cancellation, durable results and supported native-provider boundaries.
- Exercise large repositories, files, long conversations and concurrent work through restart, interruption, disk pressure and corrupted archives. Recovery must keep history durable and prevent one large response from blocking unrelated work.
- Retain matching trusted verification runtimes and their provenance across updates. Test cross-version reopen without repeating a completed model contribution. Include legitimate changes to code, tests, configuration and dependencies while preserving independent verification authority.

D2c is optional stabilization and UAT correction work, determined by observed issues after D2b. I will approve D3 separately after D2b acceptance and any required stabilization.

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
| W11 and W12 | My D2 UAT release, expanded daily-work acceptance, then distribution | The D2 exit, D2b acceptance, any required D2c corrections and explicit approval for D3 |

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
