# CrewKite

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/desktop/src/renderer/assets/crewkite-wordmark-inverse.png">
  <img src="apps/desktop/src/renderer/assets/crewkite-wordmark.png" alt="CrewKite" width="320" height="107">
</picture>

CrewKite is a desktop workspace and CLI for coding tasks that share one local controller. It tracks approvals, usage observations and retained work across provider routes.

CrewKite by Roots No Limits LLC. Created by Raymond J. Kraft.

[D2b UAT 05](https://github.com/rjk6831/crewkite/releases/tag/d2b-uat-05) is the current prerelease. It adds OpenAI Project model and effort selection before planning. Its [required CI](https://github.com/rjk6831/crewkite/actions/runs/39617852147) passed 146 Node claims and one desktop journey.

The 196,439,723-byte ZIP passed cold launch, restart and a UAT 04 upgrade with exact state preservation, backup and reopen. Public anonymous downloads matched all three assets. Human UAT, live account catalog discovery and alternate-model execution remain unqualified for this release. The [release receipt](https://github.com/rjk6831/crewkite/releases/download/d2b-uat-05/release.json) records source `fb735357`, tree `96cd6262`, the archive checksum and qualification limits. The package remains ad-hoc signed and unnotarized.

[D2b UAT 04](https://github.com/rjk6831/crewkite/releases/tag/d2b-uat-04) introduced a manual, trusted native Anthropic `/usage` report to the shared remaining-allowance gauges. Its [required CI](https://github.com/rjk6831/crewkite/actions/runs/39610727447) passed 144 Node claims and one desktop journey.

The 196,430,760-byte ZIP passed cold launch and restart checks. An upgrade from UAT 03 preserved the exact retained state, wrote its backup and reopened successfully. A separate-gauge fixture also passed. Public anonymous downloads matched all three release assets. Human UAT and a live Anthropic usage read remain pending. This exact candidate has an ad-hoc integrity seal and no notarization. The public [release receipt](https://github.com/rjk6831/crewkite/releases/download/d2b-uat-04/release.json) records source `25ccd74`, tree `3ef524c3`, the archive checksum and qualification limits.

[D2b UAT 03](https://github.com/rjk6831/crewkite/releases/tag/d2b-uat-03) introduced direct project task definition, the normal OpenAI Project execution path, simpler provider connection, local hardware facts, provider activity and credit status, project Python checks, and byte-exact GitHub job logs. Its [required CI](https://github.com/rjk6831/crewkite/actions/runs/39600267680) passed 139 Node claims and one desktop journey. The matching package passed its recorded static inventory, GUI, upgrade and retained-log checks. Its public [release receipt](https://github.com/rjk6831/crewkite/releases/download/d2b-uat-03/release.json) preserves the exact evidence and limits.

I completed ten real D2 backlog outcomes through the checked workflow. [D2 UAT 02](https://github.com/rjk6831/crewkite/releases/tag/d2-uat-02) then failed installed user acceptance. Downloaded launch, provider setup and persistent project-selection errors blocked ordinary use. That candidate remains available for issue reproduction.

[D2b UAT 02](https://github.com/rjk6831/crewkite/releases/tag/d2b-uat-02) adds bounded artifact reads and retained activity output to the workspace paging, provider setup and project-selection recovery released in [D2b UAT 01](https://github.com/rjk6831/crewkite/releases/tag/d2b-uat-01). Its [required CI](https://github.com/rjk6831/crewkite/actions/runs/39567783678) passed 111 Node claims and one desktop journey. The matching package passed static inventory, disposable upgrade, cold launch and same-home reopen checks. Public anonymous downloads matched all three release assets. The GitHub CLI download matched the archive; Chrome blocked this candidate before creating a file. Human UAT remains pending. Its public [release receipt](https://github.com/rjk6831/crewkite/releases/download/d2b-uat-02/release.json) records the source, archive checksum and qualification limits.

OpenAI Project is the only Project execution engine in this prerelease. Local, Google and Anthropic Project engines remain in progress. Existing saved file runs and CLI single-file support remain available. The new manual Anthropic reader has no live qualification yet. Its receipt time is local, while the report's observation age and account scope remain unknown. The reader sends no model prompt, enables no paid fallback and does not establish current task admission or exhaustion. The [daily-work plan](docs/daily-work-slices.md) tracks the remaining slices; [D3](docs/roadmap.md) keeps its separate approval gate.

## Why I am building it

I use OpenAI, Anthropic and Google coding subscriptions in my daily work. Each has its own interface, allowance and reset schedule. When one runs low, I stop to write a handoff and carry the context to the next tool. I keep that arithmetic in my head while trying to finish the work. Google coding in this preview uses its published ACP agent with my own Google sign-in. Its consumer CLI headless-wrapper route stays unavailable under the published policy. The [provider routes](docs/providers.md#google-acp-writer) describe the shipped workflow and setup.

After upgrading my computer, I am exploring local AI alongside my subscriptions. I want to learn which jobs local models handle well and where a subscription route is more useful. My aim is to make that choice in the same interface, with the task and its history still in front of me.

Existing coding harnesses give me useful ways to work. CrewKite is an attempt to handle the coordination around them. I want useful work from the allowance I already pay for, with routing that considers reset times and the capacity I need to keep in reserve. That preference must stay within the permissions I set. I also want to choose which roles help on a task, without staffing a whole team for a small change.

CrewKite can work with one provider, but its intended coordination value begins with at least two coding subscriptions, or one coding subscription plus Local. Each provider is optional; using all three subscriptions or Local is not required. The current Project execution path remains OpenAI-only.

The handoff matters as much as the routing. If a provider stops, I want the next one to receive the actual files and the evidence of what passed or failed, with unfinished work clearly marked. A final summary can help, but recovery should survive without it. [ADR 0007](docs/adr/0007-recover-from-durable-facts.md) records why I am building continuity around retained facts.

Community skills and plugins contain work I want to learn from and reuse. Finding the right ones and keeping up with changes takes attention. I want one consistent interface that explains what a tool does and the permissions it needs before I enable it. That should make reuse approachable for everyday AI users who have little interest in maintaining a collection of integrations. I intend to credit the original work and contribute useful improvements upstream where I can, with sources and licenses recorded in the [credits](docs/credits.md).

I am building in the open for my own daily use first. Finished work and less manual coordination will tell me whether this deserves a place alongside the tools I already use. The skills and plugin experience remains later work.

## Current workspace

- Keep the primary conversation and retained decisions with one registered project and task.
- Preview explicitly selected committed source and project logs before sending their immutable context.
- Review the proposed plan, then separately prepare the execution source, permissions and finite limits.
- Run bounded native work in independent scratch. Inspect Changes and export retained work without changing the original checkout.
- Combine two scoped child candidates through ordered checks, then require a full combined check and separate review before destination-specific branch acceptance.
- Show reported weekly, five-hour and model or pool windows with their source and freshness. Connected clients permit bounded idle metadata refresh for supported readers. After a successful OpenAI planning turn closes, the composer can show its last observed context token use and reported capacity. Missing capacity keeps the percentage unknown.
- Keep a first-party usage-limit refusal distinct from other provider failures. When the provider supplies a valid reset time, the task shows that time and a local countdown without treating it as fresh usage evidence.

The [provider notes](docs/providers.md) separate implemented paths from dated qualification. The bounded OpenAI workflow has historical checked-branch evidence. Local model eligibility, a Google quota read or a passing synthetic fixture supplies no live route qualification.

## Task workflow

This section describes the D2b UAT 04 workflow. The release receipt records the exact package and qualification limits.

Open Connect providers before starting work. Local setup has one Connect action: it saves a changed loopback endpoint, opens the existing native token input when required, and discovers models automatically. It checks status once per second for up to 20 attempts without overlapping requests. If that takes longer, use the single Refresh action. Load or unload models in the Local app; choosing an observed model saves it immediately. Google setup likewise starts with Connect Google, pauses for explicit browser sign-in when needed, then discovers the available choices. Provider quota and coding readiness remain separate facts. A connected client does not make every Project engine ready. Anthropic quota refresh requires separate native-client trust and has no live qualification in this release.

Add a Git project, then use New task on that project row to open a direct task definition with the project already selected. Enter the title, outcome and one acceptance criterion per line. The global New task action offers the same form with a project selector. Plan with AI remains optional; when used, review and adopt the plan before execution.

For a normal new task, choose Prepare run, keep the Project scope, and use the OpenAI Project profile. After a successful planning turn retains a native catalog, choose an advertised model and effort. Before that catalog exists, the profile default applies. Start checks the saved choice again. Start task opens the permission draft. Review task records the frozen source and policy; it sends no model prompt. The combined consent reads: “Allow OpenAI to read this project, edit a separate working copy, and run local commands using my signed-in client.” Subscription only is the default. Review the saved source and permissions, then choose Start task.

Manual single-file targeting is no longer the normal entry for a new task. Existing saved file runs remain visible and recoverable through their retained profile and source. Changes shows retained work. Checks and review prepares and reports separate evidence; a matching supported result still needs destination-specific permission for local branch acceptance. Messages cannot approve actions or accept code. Uncertain commands keep their exact receipt for explicit retry, and reopening starts no work. The [conversation CLI](apps/cli/README.md#task-conversations) exposes the same controller decisions.

Repository writers receive the frozen check recipe and finite turn limits with the task. Provider progress notices remain display data. They cannot complete a turn or create a candidate. Before sealing, the controller excludes generated files covered by the committed base's ignore rules, then runs the frozen formatter outside its event loop and hashes the resulting bytes. Tracked files stay eligible even when an ignore rule matches them, and a changed ignore file cannot conceal edits. A skipped or failed formatter keeps the writer bytes with its reason. Checks and review bind to the final sealed candidate.

If a submitted writer exits without a terminal result, its outcome stays unknown. Once every recorded process group is proven absent, the controller releases its lease and reservations, records bounded usage through the shutdown evidence and marks the task interrupted. It captures no candidate and starts no replacement. Reopening keeps that record and still starts no work.

A confirmed, quiescent Anthropic quota denial is the narrow retry case. Guided authority waits for explicit Resume after the reported reset. Balanced schedules one retry, and Autopilot does the same for supported standalone work. A combined run can reopen its denied native child when the sibling has passed with exact candidate provenance, is stopped on its own confirmed denial, or is entering or running the immediately next generation backed by that denial. Two same-reset wakes still honor the run's concurrency limit. Combined preparation does not support Autopilot. Restart restores one pending wait per denial. Admission rechecks current authority, ownership, source, route and remaining budget, and any drift blocks the retry. The confirmed denial consumes no attempt or minute allowance. Generic errors and unknown outcomes keep normal accounting.

## Decisions and retained work

![Project goal, planning, explicit adoption, owned execution and separate evidence and acceptance decisions.](docs/images/task-states.svg)

The diagram shows the supported decision flow. Checks, review and branch acceptance depend on the selected profile. A completed Local file candidate can use the shared checks, separate OpenAI review and destination-specific branch acceptance.

<details>
<summary>Keyboard navigation</summary>

Collapse sidebar keeps Search, New task and Usage and capacity in a compact rail. Expand sidebar restores the project and task list.

Press `Cmd+K` or `Ctrl+K`, or choose Search, to open tasks and commands. Search pages the retained task collection by task titles, outcomes, criteria, task and project IDs and project names, alongside command labels. Conversation messages are not searched. Tasks show their project, state and task ID suffix, with five matches per page.

Use Up and Down to select a result, then Enter to open it. Page Up and Page Down move between task pages; Previous tasks and Next tasks provide the same controls. `Escape` closes search and dialogs.

Review pending approval opens the existing approval card and focuses its review region. Read the exact target and consequence, then choose Approve once or Deny as a separate action. Left and Right move between task and launch tabs.


</details>

## How it fits together

![Desktop and CLI share a controller that owns durable facts, authority gates and real provider connections.](docs/images/controller-overview.svg)

The controller is a headless Node process. It owns permissions, budgets, task ownership, evidence and acceptance. Models propose plans and edits. Deterministic code decides what runs. [Architecture](docs/architecture.md) covers these boundaries. Native profiles have bounded preparation and launch paths. Their evidence and remaining qualification gates are recorded in [provider routes](docs/providers.md).

## Principles

- Qualify official clients on their supported subscription path. Cloud-provider authentication stays with those clients. CrewKite never falls back to paid API billing on its own.
- Report usage as observed. A gauge needs a real denominator, a source and a timestamp. Unknown is a valid state.
- Keep authority in code. Prompts and model output cannot grant permissions, raise limits or accept results.
- Preserve your source. Writers work in scratch copies. Results land as new local branches only.
- Keep the core small. Each new mechanism has to serve an enabled requirement or remove demonstrated work.

## Roadmap

| Milestone | Outcome | Status |
|-----------|---------|--------|
| D0 | Desktop and CLI run the full task journey against fake providers | Local demo verified |
| D1a | One qualified official client does useful supervised work with manual export | Bounded workflow complete |
| D1b | Checked results: immutable candidates, independent checks and review, local branch acceptance | Bounded workflow complete |
| D2 | Local, OpenAI, Anthropic and Google routes with handoff, honest usage and two-slice parallel work | Ten real tasks accepted; exact route and candidate evidence in the release receipt |
| D3 | Signed, documented distribution for a stated audience | Planned |

Details live in [docs/roadmap.md](docs/roadmap.md).

## Run a local workspace

For a published candidate, the [preview guide](docs/preview.md#verify-the-download) covers the download checksum and the included desktop launcher.

The [directory package](docs/distribution.md) is the normal desktop path. It carries separate Node and Electron runtimes and the fixed Local credential-input helper. It needs local Git and an existing Git identity for branch acceptance. OpenAI and Anthropic use supported installed native clients. Google ACP setup can install its reviewed official client after an explicit action. Local setup downloads or loads no model. A source-only controller has no packaged Local credential-input capability.

For maintainer staging from a committed checkout with the pinned development dependencies already installed:

```sh
internal/tools/node-v24.22.0-darwin-arm64/bin/node scripts/package.mjs --id workspace-check
internal/packages/d0/workspace-check/bin/desktop
internal/packages/d0/workspace-check/bin/crewkite task list --json
```

The default package opens a fresh workspace. Choose a project and explicit provider setup before sending work. New task defines work directly and OpenAI Project is the normal execution path. Existing initialized homes retain their state, including saved legacy file runs. A staging command or launcher does not establish a verified RC, package recovery or a released distribution. Each candidate needs its own matching verification and runtime evidence.

Project work uses a committed source read, an independent scratch copy and explicit local-command permission. Subscription only is the default; allowing existing credits is a separate choice. Candidate evaluation can run selected committed Node tests or Python `unittest` files through a frozen, pinned check definition. The [CLI guide](apps/cli/README.md) covers preparation, Stop, retained changes and export. Checks, review and branch acceptance keep their own permissions and profile limits.

<details>
<summary>Developer fixtures</summary>

`pnpm demo` explicitly selects a synthetic project and scripted providers for development. Package staging accepts `--demo` for the same purpose. These fixtures and the explicit renderer preview are separate from normal workspace startup and establish no provider qualification. [Testing](docs/testing.md) records what the synthetic collection proves. Source development requires Node 24.22.0 and pnpm 12.11.2.

</details>

## Documentation

- [Trying the preview](docs/preview.md#trying-the-preview): a short participant guide through the normal project and task workflow and recovery controls.
- [Architecture](docs/architecture.md)
- [Usage and routing](docs/routing.md)
- [Continuity and recovery](docs/continuity.md)
- [Provider routes](docs/providers.md)
- [Testing approach](docs/testing.md)
- [Design history](docs/history.md)
- [Architecture decision records](docs/adr/README.md)

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Branch names, commit messages and documentation style are checked in CI.

## Credits

The review methods draw on Ponytail, ADHD and multi. The [credits and notices](docs/credits.md) record pinned sources, the adapted contribution ladder and licenses for bundled icons and fonts.

## License

Apache License 2.0. See [LICENSE](LICENSE).
