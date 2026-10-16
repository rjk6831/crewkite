# Roadmap

I deliver CrewKite in milestones that each make one claim I can test. Dates follow measured progress, so this page lists outcomes and exits.

## Milestones

| Milestone | Outcome | Exit evidence |
|-----------|---------|---------------|
| D0 Packaged fake journey | Desktop, CLI, transport and storage share task IDs through start, approvals, stop, restart, changes and export, with scripted fake providers | The journey runs end to end on the packaged app. Fakes prove mechanics only |
| D1a Supervised native work | One qualified official client works in scratch. I can inspect activity and approvals, stop truthfully, keep an edit, reopen it and export it | A real patch from one of my projects that is worth reopening the next day |
| D1b Checked dogfood | Immutable candidates, independent checks and review, acceptance as a new local branch | A checked result branch with its evidence receipt |
| D2 Daily-driver release 0.1 | Local, OpenAI, Anthropic and Google routes in useful roles, durable handoff, honest usage, finite review, two coding slices with a combined check, safe self-development | Ten real tasks from my own backlog, observed end to end |
| D3 Distribution | Package provenance, install, recovery, compatibility, notices, privacy and signing for a stated audience | A clean install on a machine that never saw the source tree |

D1a is in progress. Normal desktop and CLI preparation support one opt-in OpenAI profile and one existing committed text file. The controller freezes the target and consent, then starts one bounded run. Native results remain unverified and available for manual export. Offline tests cover the public command path; its live launch and packaged reopen proof are pending. Earlier native pilot evidence is recorded in [provider routes](providers.md). The [CLI setup](../apps/cli/README.md#native-single-file-runs) describes preparation and export.

A two-provider demo is an intermediate step on the way to D2.

## Work packets

| Packet | Outcome | Exit |
|--------|---------|------|
| W0 | Shared contracts and the reference fixture | Agreed command, event and state contracts |
| W1 | Native account, policy and billing premise for the first route | Six pilot checks recorded, or a named blocker |
| W2 | Durable engine with finite limits | Restart never duplicates an ambiguous launch |
| W3 | Packaged desktop and CLI cockpit | The D0 fake journey |
| W4 | Real scratch edit, retain and export | A useful D1a task |
| W5 | Candidate, checks, review, local branch | D1b |
| W6 to W8 | Anthropic, Google and local routes | Per-route qualification |
| W9 | Continuity without a summary, usage controls | Ownership and budgets preserved across a handoff |
| W10 | Two coding slices with a combined check | A combined failure blocks acceptance |
| W11 and W12 | My D2 release, then distribution | The gates above and an explicit publication decision |

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
