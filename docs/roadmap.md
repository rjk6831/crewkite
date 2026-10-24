# Roadmap

I deliver CrewKite in milestones that each make one claim I can test. Dates follow measured progress, so this page lists outcomes and exits.

## Milestones

| Milestone | Outcome | Exit evidence |
|-----------|---------|---------------|
| D0 Packaged fake journey | Desktop, CLI, transport and storage share task IDs through start, approvals, stop, restart, changes and export, with scripted fake providers | The journey runs end to end on the packaged app. Fakes prove mechanics only |
| D1a Supervised native work | One qualified official client works in scratch. I can inspect activity and approvals, stop truthfully, keep an edit, reopen it and export it | A real patch from one of my projects that is worth reopening the next day |
| D1b Checked dogfood | Immutable candidates, independent checks and review, acceptance as a new local branch | A checked result branch with its evidence receipt |
| D2 Daily-driver release 0.1 | Qualified OpenAI, Anthropic, Google and Local routes in useful roles, durable handoff, honest usage, finite review, two coding slices with a combined check, safe self-development | Ten real tasks from my own backlog, observed end to end |
| D2b Daily-work scale and acceptance | Independently released D2b.1 onward: large projects and GitHub/CI first, multi-file coding and commands next, recovery and measured acceptance, then local history modes | Each slice has its own green CI and UAT package. The representative real-project matrix passes before a coding-scope claim |
| D2c Optional stabilization | UAT corrections and remaining stabilization identified after D2b | Required corrections are verified; this milestone is used when observed issues need it |
| D3 Distribution | Package provenance, install, recovery, compatibility, notices, privacy and signing for a stated audience | A clean install on a machine that never saw the source tree |

D1a is complete for the bounded OpenAI single-file profile. It supports an existing committed text file. A useful documentation task produced a retained patch. Later synthetic tasks passed normal desktop and fresh package launch, CLI export and same-home reopen. Stop retained interrupted work without applying it. The original source stayed unchanged. The Anthropic single-file pilot recorded launch, export, Stop and same-home reopen with explicit subscription-login and disabled-extra-usage confirmations. Its local native path remains available under the existing admission checks. Prior Google pilots recorded those mechanics without establishing current integration permission. Google consumer automatic launch is unavailable under its published integration policy. [Provider routes](providers.md#current-availability) records the dated boundaries and historical evidence. Manual native file handoff has [offline fixture coverage](continuity.md#manual-native-file-handoffs) with explicit recipients and fresh consent. Connected transfer and general live routing remain unqualified. Useful bounded Local work is recorded separately below. Local acceptance follows the separate D1b evidence and permission path. The [CLI setup](../apps/cli/README.md#native-single-file-runs) describes the available OpenAI and Anthropic preparation and manual export.

D1b is complete for one useful CrewKite repository task. A live OpenAI writer removed redundant completed check and review controls from the evaluation view. The Mac directory package ran all six fixed verification stages and all 40 tests against that immutable candidate. A fresh native review passed with zero findings and same-family process independence only. A separate destination-specific approval created the exact checked result on the local `feat/evaluation-outcomes` branch. The same home reopened with its branch and evidence intact, without another submission. The original checkout and index stayed unchanged. This meets the checked-result exit above. The recipe requires a matching registered source checkout with installed development dependencies and Electron. A separate live OpenAI repository Stop retained interrupted work through same-home reopen. Full profile qualification remains pending. D2's ten-task evidence is recorded below. Broader routing and handoff retain their stated limits. D3 still requires a clean install on a machine that never saw the source tree.

The primary conversation now retains messages, questions, answers and proposed plans. Explicit adoption saves the task contract without starting execution. Planning uses the supported profile and finite task budget; selected committed source and explicit project logs are captured as immutable context. The controller owns permissions, budgets and acceptance under [ADR 0002](adr/0002-authority-in-deterministic-code.md). This implements part of the daily workspace in [ADR 0001](adr/0001-coding-workspace-for-daily-projects.md); it establishes no autonomous coordination or planning-route qualification.

Primary planning now saves supported model and effort requests from a successful turn's last-observed catalog. The next admitted turn validates the requested pair again. Future execution policy opens an explicit preparation draft and leaves existing execution policy frozen. These controls preserve read-only planning, cumulative task limits and separate grants.

D2 requires qualified routes across all four families, a useful qualified Local role and operation with Local disabled, durable approved handoffs, honest usage, finite independent review, useful two-slice work with a combined check, and safe self-development. On 2026-10-20, ten distinct real backlog outcomes completed their original checks, separate native review, destination acceptance and same-home reopen. The record includes useful bounded Local work and one two-slice outcome with its combined check and whole-parent review. The release receipt binds the exact routes, candidate source and separate verification and package observations. General live routing and unobserved provider operations retain their stated limits. Real-project D2b acceptance and required corrections remain pending; I will explicitly approve any D3 start.

The bounded combined workflow implements two scoped child writers, one shared budget, checked ordered replay and a separate full check and review of the final candidate. Immutable contributor origins and guarded private ref updates prevent passing slices from bypassing the combined barrier. Offline fixtures cover controller mechanics, parent controls and interrupted ownership. A supervised two-slice documentation task completed baseline checks, both writers, ordered replay, the combined check and whole-parent review, followed by branch acceptance and same-home reopen. It used the fixed project Node recipe and process independence only. That combined task counts once among the ten outcomes. Broader provider qualification and real-project user acceptance keep their separate gates.

I chose the separate ACP profile for Google's coding path in D2. The consumer headless writer stays blocked. The [bounded ACP workflow](providers.md#google-acp-writer) binds its production review-mode and edit-tool mappings to one exact imported bundle. Personal-account authentication and configuration discovery have completed through normal setup. A useful bounded coding task completed its original checks, separate review, destination acceptance and same-home reopen. Its record identifies the exact client, selected configuration and permission actions actually observed. Active task Stop and installed recovery remain unverified without their own dated proof. The default-on quota read supplies no coding authority. [Proposed ADR 0024](adr/0024-integrate-google-through-its-published-acp-agent.md) records this decision; Accepted ADR 0012 remains unchanged.

I published [D2 UAT 02](https://github.com/rjk6831/crewkite/releases/tag/d2-uat-02) from source `32bc92e52ea38d85afc49d03fda433f6807d9c43`. Matching local verification and main CI passed 95 Node checks and one desktop journey. The exact ZIP passed inventory and notice checks, empty-workspace cold launch and same-home reopen, followed by anonymous download and checksum verification. The release receipt records the route observations and assistance scope. Signing, notarization, fresh-machine opening and the declared minimum OS remain unqualified. Real-project user acceptance is the next evidence gate.

## D2b daily-work acceptance

The current line of work is the chat thread. A thread is a streamed session on one scratch copy of a project, with four provider adapters behind one event contract, permissions answered in the thread and a handoff that moves the thread between providers. [Proposed ADR 0036](adr/0036-the-chat-thread-is-the-product-center.md) records the decision and what it removes. None of the four adapters has a live run on record yet, and [provider routes](providers.md#chat-adapters) says so for each.

I will ship D2b in small usable releases, beginning after the verified D2 UAT package. [Daily-work slices](daily-work-slices.md) is the implementation entry point and progress record. It names the next slice, actual code gaps, dependencies, acceptance and package release steps.

D2b.1 separates workspace/task status from whole-history reads. D2b.2 streams retained artifacts and output; D2b.3 scales project capture. D2b.4 adds task-linked GitHub PR, Actions status and CI logs. Large diffs and context, project commands and useful multi-file changes follow as separate releases, leading into checked push and PR publication. Restart and cross-version recovery complete the representative daily-work acceptance suite before I claim the stated coding scope.

Instant History and optional older-history compression follow the coding releases. They retain the history CrewKite actually receives, with local indexes, segmented reads and measured cold/warm access. Separate cloud-app history still requires a supported access or import path.

One usable release every day or so is the target. Three implementation lanes cover project scale, GitHub/CI and commands/multi-file work, with one integration owner and independent QA. Shared contracts freeze first; development can overlap before dependency releases. Recovery and compatibility work start on Day 1. The daily-work coding core has a conditional 3-5 working-day target after D2 shipment and capacity verification. The first two slices establish measured throughput; a slice that grows splits at a usable boundary. An eligible ready feature can ship before an independent lower-numbered slice. History and compression are stretch work for that window. Each release keeps its source, CI and package evidence separate. D2b.1, D2b.2 and subsequent numbers stay under one milestone, so a small delivery does not redefine the D2 exit or create another distribution milestone.

D2c remains optional stabilization driven by observed UAT issues. Required daily-work corrections cannot be deferred behind a parity claim. I will approve D3 separately after D2b acceptance and any required stabilization.

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
