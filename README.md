# CrewKite

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/desktop/src/renderer/assets/crewkite-wordmark-inverse.png">
  <img src="apps/desktop/src/renderer/assets/crewkite-wordmark.png" alt="CrewKite" width="320" height="107">
</picture>

CrewKite is a desktop workspace and CLI for coding tasks that share one local controller. It tracks approvals, usage observations and retained work across provider routes.

I completed ten real D2 backlog outcomes through the normal checked workflow. I am preparing their composed candidate for real-project user acceptance on macOS with Apple Silicon. The normal workspace starts without a synthetic project or seeded route catalog. Native profiles connect to their supported clients; Local setup uses an explicitly configured loopback connection. Availability is separate from qualification. The separate Google ACP profile binds its supported mappings to an exact imported client bundle. The [roadmap](docs/roadmap.md) records that task evidence and the separate D2b user-acceptance and D3 gates. The release receipt carries the exact candidate verification and package status.

## Why I am building it

I use OpenAI and Anthropic coding subscriptions in my daily work. Each has its own interface, allowance and reset schedule. When one runs low, I stop to write a handoff and carry the context to the next tool. I keep that arithmetic in my head while trying to finish the work. Google consumer CLI launch is deferred because its published headless policy excludes third-party application wrappers.

After upgrading my computer, I am exploring local AI alongside my subscriptions. I want to learn which jobs local models handle well and where a subscription route is more useful. My aim is to make that choice in the same interface, with the task and its history still in front of me.

Existing coding harnesses give me useful ways to work. CrewKite is an attempt to handle the coordination around them. I want useful work from the allowance I already pay for, with routing that considers reset times and the capacity I need to keep in reserve. That preference must stay within the permissions I set. I also want to choose which roles help on a task, without staffing a whole team for a small change.

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

Open Usage and capacity to inspect route availability and explicit provider setup. Local setup connects to a dedicated loopback runtime, refreshes its observed model list and saves one selection. Dedicated token is the default. An explicit CLI configuration can select no authentication, this device only; the desktop reports that saved mode without a selector or silent fallback. That mode needs no token input after restart. Setup loads no model. An eligible loaded model remains unqualified; the [provider notes](docs/providers.md#local-models) describe the current limits.

Choose New task, select a registered project and review the planning permission before sending. Conversation is the main task view. Answer the primary role's questions and inspect the proposed criteria and scope before choosing Adopt plan. Adoption saves the task contract and opens separate execution preparation. It starts no coding work.

Planning settings keep Lead or Orchestrator on the supported OpenAI profile, with existing-credit permission and finite task limits. After a successful turn, model and effort choices come from that turn's last-observed catalog. Choose an advertised pair and explicitly Save. Saving starts no work. The next admitted turn checks the pair again before sending its prompt. Missing or stale choices keep their reason. Returning to the profile default also needs an explicit Save. Requested settings remain separate from acknowledged effective settings. Planning and later execution share the task's finite budget.

Saving a material model or effort change creates a linked planning run and returns the task contract to provisional. Review and adopt a fresh valid plan before preparing execution.

Future execution policy opens a separate preparation draft. Planning keeps read-only, tool-free permissions. Review the supported authority, source sharing and grants before explicit preparation. A saved or running execution keeps its frozen policy.

Review the prepared source and permissions before Start. Changes shows retained work. Checks and review prepares and reports separate evidence; a matching supported result still needs destination-specific permission for local branch acceptance. Messages cannot approve actions or accept code. Uncertain commands keep their exact receipt for explicit retry, and reopening starts no work. The [conversation CLI](apps/cli/README.md#task-conversations) exposes the same controller decisions.

Repository writers receive the frozen check recipe and finite turn limits with the task. Provider progress notices remain display data. They cannot complete a turn or create a candidate. Before sealing, the controller excludes generated files covered by the committed base's ignore rules, then runs the frozen formatter outside its event loop and hashes the resulting bytes. Tracked files stay eligible even when an ignore rule matches them, and a changed ignore file cannot conceal edits. A skipped or failed formatter keeps the writer bytes with its reason. Checks and review bind to the final sealed candidate.

If a submitted writer exits without a terminal result, its outcome stays unknown. Once every recorded process group is proven absent, the controller releases its lease and reservations, records bounded usage through the shutdown evidence and marks the task interrupted. It captures no candidate and starts no replacement. Reopening keeps that record and still starts no work.

A confirmed, quiescent Anthropic quota denial is the narrow retry case. Guided authority waits for explicit Resume after the reported reset. Balanced schedules one retry, and Autopilot does the same for supported standalone work. A combined run can reopen its denied native child when the sibling has passed with exact candidate provenance, is stopped on its own confirmed denial, or is entering or running the immediately next generation backed by that denial. Two same-reset wakes still honor the run's concurrency limit. Combined preparation does not support Autopilot. Restart restores one pending wait per denial. Admission rechecks current authority, ownership, source, route and remaining budget, and any drift blocks the retry. The confirmed denial consumes no attempt or minute allowance. Generic errors and unknown outcomes keep normal accounting.

## Decisions and retained work

![Project goal, planning, explicit adoption, owned execution and separate evidence and acceptance decisions.](docs/images/task-states.svg)

The diagram shows the supported decision flow. Checks, review and branch acceptance depend on the selected profile. A completed Local file candidate can use the shared checks, separate OpenAI review and destination-specific branch acceptance.

<details>
<summary>Keyboard navigation</summary>

Collapse sidebar keeps Search, New task and Usage and capacity in a compact rail. Expand sidebar restores the project and task list.

Press `Cmd+K` or `Ctrl+K`, or choose Search, to open tasks and commands. Search matches task titles, outcomes, criteria, task and project IDs, project names and command labels in the current snapshot. Conversation messages are not searched. Tasks show their project, state and task ID suffix, with five matches per page.

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

The [directory package](docs/distribution.md) is the normal desktop path. It carries separate Node and Electron runtimes and the fixed Local credential-input helper. It needs local Git, an existing Git identity for branch acceptance and separately installed provider clients. It downloads no provider or model. A source-only controller has no packaged Local credential-input capability.

For maintainer staging from a committed checkout with the pinned development dependencies already installed:

```sh
internal/tools/node-v24.22.0-darwin-arm64/bin/node scripts/package.mjs --id workspace-check
internal/packages/d0/workspace-check/bin/desktop
internal/packages/d0/workspace-check/bin/crewkite task list --json
```

The default package opens a fresh workspace. Choose a project and explicit provider setup before sending work. Existing initialized homes retain their state. A staging command or launcher does not establish a verified RC, package recovery or a released distribution. Each candidate needs its own matching verification and runtime evidence.

For native single-file work, review the supported writer, committed target and scoped consent before preparation and Start. Existing-credit spending defaults off. Anthropic requires explicit subscription-login and disabled-extra-usage confirmations. Repository work uses a separate OpenAI profile and local-command permission. The [CLI guide](apps/cli/README.md) covers conversation, preparation, Stop, retained changes and export. Checks, review and branch acceptance keep their own permissions and profile limits.

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
