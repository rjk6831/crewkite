# Daily-work slices

I want useful changes in my hands every day or so. I will keep D2b as one milestone and release D2b.1, D2b.2 and subsequent slices independently. Each slice gets its own review, green CI and runnable UAT package. D2c remains available for corrections that need a separate stabilization round. D3 still needs my explicit approval.

The next candidate must close provider connection and project-selection recovery failures first. Large-project handling and GitHub/CI work follow that usable baseline. Practical multi-file changes and project commands follow. Recovery has to hold throughout, and gets a separate acceptance pass before I claim coding parity. Instant History and Optimized Storage stay in scope after the coding workflow.

## Start here

This file is the implementation entry point. Read it together with [architecture](architecture.md), [testing](testing.md), [distribution](distribution.md), the [roadmap](roadmap.md) and the repository's current local instructions. Inspect the code and current release evidence before changing anything. A planned capability below is a gap to verify, not an existing feature to assume.

Current slice: D2b.1, workspace and task status pages, with blocking UAT corrections before the next package. [D2 UAT 02](https://github.com/rjk6831/crewkite/releases/tag/d2-uat-02) failed installed UAT and remains available for issue reproduction. Its retained checks, inventory and unquarantined empty-workspace launch evidence do not establish usable provider setup or project registration. The public release marks that failure. No D2b package is qualified yet.

[The runtime repair](https://github.com/rjk6831/crewkite/pull/55) passed required CI and merged. It seals staged runtime resources and records the limits of ad-hoc integrity checks. Downloaded first launch still needs its own evidence. The paging and project-recovery branch has a real-controller desktop and CLI proof with 304 tasks and a 1,365,503-byte legacy snapshot. [The paging and recovery repair](https://github.com/rjk6831/crewkite/pull/56) passed required CI with 101 Node claims and one desktop journey and merged. Provider setup integration and a replacement package remain pending.

| Current-slice card | D2b.1 |
|--------------------|-------|
| Visible result | Open a large workspace, select a task and inspect status through desktop and CLI |
| Edit boundary | Shared read contracts, store/controller projections, socket client, desktop and CLI navigation, and terminal project-validation refusals |
| Deferred | Artifact bytes, large activity bodies, repository capture, context selection and compression |
| Required proof | Complete pages beyond the former 1 MiB snapshot, reconnect and usable Stop; recover an old pending project command and select another folder; matching CI and UAT archive |
| Entry check | Retained D2 outcomes and current main inspected; preserve existing state, work and source history |

For the next implementation, use this instruction:

> Read docs/daily-work-slices.md. Verify its progress table against main, CI and the published release receipt. Select the first eligible unreleased slice that fits the available lane, including its named acceptance checks and documentation. Coordinate against the active ownership map before writing. Review it independently, commit it, pass the required CI, and publish a separate UAT candidate with matching source and package evidence. Update this file with the result and the next slice. Preserve existing work and authority boundaries. Reuse concrete authorization already given for this repository and release path; request missing authority only for a new destination or effect. Report an observed blocker with its evidence; do not mark unobserved work complete.

Development can begin against a reviewed frozen interface before its dependency is released. Mark that work dependent and test it with local fixtures. A release is eligible only when every listed dependency has released and its required acceptance is recorded. Ship an eligible ready slice even when a lower-numbered independent slice is unfinished; published slice IDs stay stable. Fix a regression that makes existing work unsafe before opening another feature. If a slice needs more than about a day of implementation, split it at a usable boundary and renumber the remaining unreleased rows and dependencies. Published slice IDs never change. Keep the unfinished capability explicit. A schema-only change can accompany the feature it enables; it does not count as that day's usable feature.

## Provider setup during UAT

OpenAI and Anthropic setup still depends on supported installed clients. The Google correction adds installation of the reviewed official ACP client before its separate authentication flow. Local needs an already loaded compatible model and explicit connection setup. Planning currently uses the supported OpenAI profile; execution roles keep their own provider boundaries.

The failed UAT exposed missing provider readiness, an OpenAI quota read that silently failed, a Google initialization button with no client installation path, and a rejected project selection that remained globally pending across restart. These corrections gate the next candidate. They do not add another daily-work slice.

I need one setup view that shows the installed build, observed sign-in state and exact next action for each family. Keep installation, authentication, allowance and coding qualification separate. The Google path must install the reviewed official client and guide personal sign-in without terminal staging. An Anthropic sign-in check must use the native metadata command without a prompt; unavailable standalone quota stays unknown. OpenAI quota refresh must show its result or an actionable failure. Metadata checks cannot block project selection or Stop. Existing uncertain project mutations still need exact reconciliation.

Before another UAT handoff, use a fresh package to open the workspace, connect the supported installed clients, reject an invalid folder, recover the previous pending selection, add a valid project and reopen the same home. Preserve original project files and existing state. Record actual account and device observations separately from offline fixtures.

## What exists at the planning baseline

I inspected source `55751868f8e6feb96742ba919d26c163424a1977`. These are code boundaries, separate from connected qualification and package observations:

| Area | Current behavior | Work needed |
|------|------------------|-------------|
| Workspace reads | `GetSnapshot` supports task or approval scope. A complete workspace snapshot still has to fit a 1 MiB frame | Page the project/task lists and selected views; stop loading unrelated history to show status |
| Artifacts and activity | `GetArtifact` returns at most 64 KiB per response, after reading and hashing the complete artifact. The artifact reader refuses files above 64 MiB. Task activity has exclusive-cursor pages, but one oversized event refuses the page | Use actual ranged reads and incremental validation; retain large event bodies separately and keep every page navigable |
| Source and integration | Source capture, scratch capture and private integration have 64 MiB aggregate paths; source capture permits at most 10,000 files. Source inspection shows at most 200 entries and 64 KiB of details | Stream manifests and content, page inspection and diffs, and measure disk and memory use without fixed aggregate project ceilings |
| Selected context | Four selections, 32 files, 8 KiB per file and 32 KiB for the encoded bundle | Select and retrieve larger context by immutable ranges, with explicit provider-context accounting |
| Coding | A native repository profile can capture multiple changed files. Combined work has two single-file child scopes. Checks support selected immutable Node files and the fixed repository verification recipe | Qualify normal multi-file work, allow legitimate test/configuration changes through independently frozen evaluation, and expose useful project commands |
| Git and GitHub | Acceptance creates a new local result branch. It does not merge, push or deploy. There is no general controller shell, GitHub CLI, PR or Actions operation | Add scoped read and effect operations through the existing controller owner, with durable results and explicit external destinations |
| Retention | SQLite stores state and ordered events. Immutable files hold large evidence. Reopen and process ownership already have specific recovery rules | Make large reads usable across restarts and updates; preserve evidence definitions and add measured local history retrieval |

Recheck these paths at the actual starting commit. Existing behavior may have advanced. Reuse a helper that already solves the claim; remove a row only after the remaining gap is demonstrated absent.

## Release order and progress

A day is a target for the next usable increment. It includes review and release work when those finish normally. The parallel schedule below targets the core coding workflow in 3-5 working days after verified D2 shipment and confirmed capacity. Large-copy and recovery failures can move that date. I will re-estimate from the first two release receipts.

| Slice | Usable result | Depends on | State | Source, CI and UAT evidence |
|-------|---------------|------------|-------|-----------------------------|
| D2b.1 | Recover project selection and read large workspace status through complete pages | Retained D2 workflow and current main | Qualification pending | Real desktop and CLI proof: 304 tasks, legacy snapshot 1,365,503 bytes; pending-command restart recovery and required CI passed in PR #56. Replacement package pending |
| D2b.2 | Read large artifacts and activity output with bounded memory | D2b.1 | Planned | None |
| D2b.3 | Prepare and retain a project beyond the old source-size limits | D2b.2 | Planned | None |
| D2b.4 | See GitHub PR, Actions status and full CI logs inside a task | D2b.2 | Planned | None |
| D2b.5 | Navigate large diffs and select useful context by range | D2b.3 | Planned | None |
| D2b.6 | Run and stop explicit project commands with durable output | D2b.2 | Planned | None |
| D2b.7 | Complete a useful multi-file change with matching diffs and tests | D2b.5, D2b.6 | Planned | None |
| D2b.8 | Publish a checked branch and open or update its PR | D2b.4, D2b.7 | Planned | None |
| D2b.9 | Recover work and verification across restart and application updates | D2b.8 | Planned | None |
| D2b.10 | Pass the representative daily-work suite and close its observed gaps | D2b.9 | Planned | None |
| D2b.11 | Open and scroll retained local history quickly | D2b.10 | Planned | None |
| D2b.12 | Compress older history without losing access or integrity | D2b.11 | Planned | None |

D2b.3 and D2b.4 can be developed alongside each other after their read contract is stable. D2b.6 can also proceed once the output path is available, so project commands need not wait for every context improvement. Land shared contracts and migrations through one integration owner. Do not create competing command owners. Ship the earliest ready slice without waiting for another lane. History work cannot delay the first usable coding releases.

## Parallel delivery and critical path

I will run at most three implementation lanes, with one integration owner and a separate QA/review role. That is the working limit for this pass. More writers would contend for the same contracts, store, controller wiring and package verification. I can use focused subagents inside a lane for a test fixture, code review or a clearly separate module. Each still needs an owner and an exclusive write scope.

The integration owner records the active worktree, branch, owner and files for each lane before it starts. A lane keeps one writer per file. Helpers use a separate worktree or a disjoint assigned file set. Shared changes are proposed as a diff to the integration owner; they are never silently edited by several lanes.

| Lane | Owns | Starts before dependencies release | Shared boundary |
|------|------|------------------------------------|-----------------|
| A, project scale | D2b.2 artifact/output implementation, then D2b.3 source capture and D2b.5 diff/context modules, their focused tests and assigned views | Range-read fixtures, streaming capture, manifest and diff paging implementations against frozen read contracts | Artifact publication, source identity and selected-context contracts |
| B, GitHub/CI | D2b.4 repository/PR/Actions/log reads, then the remote portion of D2b.8, with operation-specific views and tests | Installed-client inspection, deterministic executable fixtures and remote reconciliation tests | Operation intents, destination authority and immutable log references |
| C, commands and coding | D2b.6 command runner, then D2b.7 multi-file evaluation and project-check workflow, with assigned tests/views | Command definition and ownership fixtures, changed-test evaluator design and supported-profile gap audit | Existing process owner, check definitions and candidate identity |
| Integration | D2b.1 list/status projections and wiring; shared contracts, migrations, lockfile, entry points and final composition | Freeze small interfaces and wire completed lane changes incrementally | One schema/migration sequence, one controller owner, one reviewed main |
| QA/review | Independent diffs, regression fixtures, recovery/compatibility evidence and the D2b.10 daily-work matrix | Begin restart, fault, old-home and responsiveness fixtures on Day 1; prepare representative repositories and backlog issues | Review adds no source or effect authority; findings return to the owning lane |

Use separate planned checkouts under `internal/worktrees/`: `project-scale` on `feat/project-scale`, `github-workflows` on `feat/github-workflows`, and `project-commands` on `feat/project-commands`. The integration checkout uses `feat/daily-work-integration`; a writable acceptance-fixture lane uses `test/daily-work-acceptance`. These are proposed assignments, not checkouts this document created. Inspect existing worktrees before creating or reusing one, preserve its work, and record the actual path and frozen base. Lane A owns the source, integration, artifact and context modules named below. B owns its GitHub module and assigned PR/CI view files. C owns its command module, worker/toolchain changes and assigned command/evaluation views. The integration owner alone edits the shared contracts, central controller wiring, migrations, lockfile and entry points. Record exact test and renderer files before any helper writes them.

A lane can narrow its task further and hand a fixture or review to a subagent. It cannot raise account limits, split one task to evade a cap or assume the other client's subagent feature exists. Provider assignment follows observed current availability and the supported client capability. Verify access and capacity through the existing authorized status/setup path before assigning OpenAI, Anthropic, Google or Local work. Record the ordinary-subscription billing mode, route and remaining campaign limits privately. Keep missing or uncertain capacity unassigned. No paid-credit route or automatic fallback is part of this schedule.

This is the development coordination plan. It makes no claim that the released app already orchestrates these clients or their subagents automatically. It also dispatches no provider work by itself. Existing concrete authorization applies within its scope; new live campaigns and new destinations keep their own authority.

The shared read and output interfaces are the first dependency. Freeze their page/cursor, artifact range/integrity and operation-result shapes before the lanes consume them. Freeze command ownership and error semantics alongside them, so B and C can build fixtures while A completes streaming. A frozen interface includes invalid-input, cancellation and compatibility cases. Changing it requires one integration review and a clear update to every consumer.

| Wave | Independent work | Release gate |
|------|------------------|--------------|
| Foundation | Integrate D2b.1; A builds D2b.2; B prepares D2b.4; C prepares D2b.6; QA starts recovery and update fixtures | Publish D2b.1, then D2b.2 only with their actual evidence |
| Coding features | A develops D2b.3 then D2b.5; B completes D2b.4 and prepares D2b.8; C completes D2b.6 and develops D2b.7 | Publish each ready feature after its table dependencies; D2b.4 or D2b.6 can precede D2b.3 |
| Joined workflow | Compose D2b.7 and D2b.8; run the restart/update matrix against actual packages; exercise the real backlog issue and final remote head | D2b.9 and D2b.10 close only after the full workflow and required corrections pass |

The longest dependency chain is D2b.1 -> D2b.2 -> D2b.3 -> D2b.5 -> D2b.7 -> D2b.8 -> D2b.9 -> D2b.10. D2b.6 joins before D2b.7; D2b.4 joins before D2b.8. These are release gates. Implementation, tests and review overlap wherever ownership permits.

Recovery work starts with the first contract. Every early slice exercises its own cancellation, restart and retained-data compatibility before release. D2b.9 supplies the joined cross-version and remote-effect proof after those effects exist. It is not the first day anyone looks at recovery.

## First five days

These are working targets, conditional on verified D2 shipment, available ordinary-subscription capacity and no new correctness blocker. A target date never turns missing evidence into a pass.

| Day | Parallel target | Earliest useful release |
|-----|-----------------|-------------------------|
| 1 | Freeze shared interfaces, implement workspace/status paging, start ranged output; prepare GitHub and command fixtures; baseline recovery, old-home compatibility and responsiveness | D2b.1, if its exact source, CI and archive checks pass |
| 2 | Finish large output reads; implement source streaming; connect task-linked GitHub/CI reads and project command output; continue injected interruption tests | D2b.2, then D2b.4 or D2b.6 if ready and eligible |
| 3 | Complete large-project capture; finish commands and paged diff/context; prepare multi-file checks and remote publication reconciliation | D2b.3 and any ready D2b.4/D2b.6; D2b.5 when its source dependency has released |
| 4 | Exercise useful multi-file work with changed tests; compose checked push and PR; run the prior-package home through the update path and address failures | D2b.5/D2b.7, then D2b.8 if the exact joined workflow passes |
| 5 | Finish publication, cross-version and uncertainty cases; run the representative daily-work matrix on the final published head and package; close required gaps | D2b.8/D2b.9/D2b.10 only when all required observations pass |

The 3-5 day target covers D2b.1 through D2b.10 and depends on overlap; it does not mean ten full-day tasks run serially. It has moderate confidence before the first two receipts. Re-estimate after Day 1 and Day 2 using actual contract churn, verification duration and observed route availability. A larger implementation or failed daily-work scenario moves the target or splits the remaining scope visibly. Do not lower the acceptance bar to keep the date.

Adding providers can shorten independent implementation and review. It does not shorten a dependent contract change, remote reconciliation, test execution or exact-package cold/reopen proof. Concurrent large copies and builds also compete for disk and CPU. Keep heavy verification runs scheduled, use focused checks during development, and run the required full verification for each final source. Extra available capacity is useful for independent review and fault-case preparation; it is not a reason to add competing migrations or writers.

History index design and baseline measurements can use idle capacity from Day 1. Implementation uses a lane only when that does not delay the core coding path. Full Instant History and compression in the same 3-5 days are stretch work, with their own format, integrity and retrieval evidence. They remain D2b.11 and D2b.12 even if preliminary design starts early.

A one-day slice means one visible workflow improvement, a named regression check, independent review, green required CI and a matching UAT package. It is a scope boundary, not a calendar guarantee. Source-only progress stays Source verified. If release checks uncover a fault, repair it and keep the previous working package available. The first slice deliberately stops at workspace/task status paging. Large output bodies, source capture, context selection and compression have their own releases.

Keep a row Planned, In progress, Blocked, Source verified, Packaged, Released or UAT accepted. Released means the downloadable artifact was checked. UAT accepted requires a real observation of the advertised workflow. Record exact source, required CI run, release URL, artifact checksum, acceptance scope and remaining limits in the final column. An automated fixture does not establish native route qualification.

## D2b.1: workspace and task status pages

I need task status to stay usable as the number of tasks grows. One response should contain the requested page and enough metadata to continue.

- Add cursor-based project/task list and status projections. Bind pages to a consistent revision or watermark, define concurrent-update behavior, and reject a stale cursor with an actionable refresh path. Keep mutation authority separate from read cursors.
- Include the selected task's summary and references needed for its controls. Leave unrelated conversations, activity bodies and artifact content out of these status projections. Preserve the existing scoped task detail path until its own replacement is qualified.
- Update the desktop's initial workspace list, task selection and reconnect, plus CLI list/status, to use these projections. Preserve visible loading, unavailable and incomplete states. A failed page must not display a shortened result as complete.
- Keep per-frame bounds, read cancellation and fair scheduling so status reads leave Stop and another task usable. Retain compatibility explicitly for older clients.

Primary boundaries: `packages/contracts/src/index.ts`, `packages/client/src/index.ts`, `apps/controller/src/server/index.ts`, `apps/controller/src/commands/controller.ts`, store projections, desktop main/renderer and the CLI. [Proposed ADR 0027](adr/0027-page-large-data-without-project-size-ceilings.md) records the read design.

Acceptance: retain enough tasks to exceed the old 1 MiB workspace snapshot. Open the workspace, select a task, read its status and reach the last task through normal desktop and CLI. Include concurrent updates, stale cursors, cancelled reads and reconnect. Prove no missing or duplicated entries at the documented watermark. Measure peak resident memory and time until status becomes usable. No implementation or acceptance for large artifacts, oversized activity bodies, source streaming or larger context belongs in this first slice.

## D2b.2: artifact and activity output reads

I need to read the complete retained output without allocating it all on each request.

- Add actual ranged file reads with immutable identity, length and integrity metadata. Verify complete content incrementally before it becomes trusted evidence; a partial display supplies no whole-file checksum proof.
- Stream publication of large content into durable immutable files. Keep the last valid artifact on cancellation or disk failure. Remove the artifact's aggregate 64 MiB read ceiling after its publication and verification path supports the larger bytes.
- Move large activity bodies behind artifact references while keeping their event identity and order. Define compatibility for already retained oversized events. Page output in the desktop and CLI, with explicit completeness and retrieval failures.
- Apply backpressure and cancellation. A large read cannot block Stop or unrelated status. Preserve a failed operation and its durable reason without presenting partial output as complete.

Primary boundaries: `apps/controller/src/artifacts/index.ts`, `apps/controller/src/store/activity.ts`, controller, contracts, client and task output views. This slice leaves repository source capture and provider-context selection unchanged.

Acceptance: reconstruct a retained artifact larger than 64 MiB through normal reads and verify its exact checksum. Read an oversized single activity body, including its first and last bytes. Exercise cancellation, missing/corrupt content, interrupted publication, low disk and reconnect. Record peak memory and prove it does not grow with the entire artifact in memory.

## D2b.3: large project capture

I need a project to fit on disk without also requiring every byte in one JavaScript buffer.

- Stream Git object enumeration, hashing and independent scratch materialization. Preserve raw paths, executable modes, committed ignore rules, dirty-source disclosure and unchanged-source checks. Apply the same approach to private integration and candidate capture.
- Preserve unsupported binary content without claiming it has a text review. Keep links, traversal, special-file and submodule restrictions visible unless separately designed and qualified.
- Account for disk availability and reserve needed for staging. A preflight estimate is advisory; handle short writes and disk-full errors without publishing partial candidates.

Primary boundaries: `apps/controller/src/host/source.ts`, `apps/controller/src/host/integration.ts`, `apps/controller/src/host/integration-git.ts`, artifacts, controller and contracts. Do not solve only the entry scan while leaving capture or integration under the old aggregate ceiling. Large context and diff navigation stay in D2b.5.

Acceptance: register and prepare a generated repository over 10,000 tracked files and 64 MiB, with one text file above the old aggregate bound. Make a small scoped edit, seal the exact candidate, verify it and reopen it. Include additions, deletions, Unicode paths, mode changes and unchanged dirty/untracked sentinels. Exercise cancellation, insufficient disk and missing Git objects. Publish repository size, file count, peak memory, disk overhead and capture time. Start with a 20,000-file, 256 MiB fixture and increase it if the intended real project is larger. These are qualification sizes, not new product ceilings. A small edit in a large repository does not qualify a large diff.

## D2b.4: GitHub and CI reads

I need to see why a PR failed without leaving the task or clipping its log.

- Use an existing configured `gh` executable and its ordinary authentication. Pin executable identity for the operation. Keep credentials in the client and redact secrets from retained output. Report missing authentication and scopes; do not start login or alter the account.
- Bind reads to an explicit repository, PR or commit and workflow run/job. Retain sourced status and retrieval time. Fetch logs incrementally into artifacts, with pages, download progress, cancellation and honest unavailable/expired states.
- Add task-linked PR and check views with links back to the actual remote objects. A summary is optional; raw retained logs remain accessible. Refresh requires a new read and cannot start inference.

Primary boundaries: a controller-owned GitHub operation module, contracts, the existing process owner, artifacts, CLI and task views. Reuse the operation foundation in [Proposed ADR 0028](adr/0028-journal-project-commands-and-remote-effects.md).

Acceptance: use deterministic local executable fixtures for pending, passed, failed, cancelled, rerun and unavailable logs, including a log larger than a frame. Record commit and run identity so a new head cannot inherit an old green check. Qualify one already authorized real repository read separately. Read authority grants no push, PR mutation, workflow dispatch, rerun, cancellation or secret access.

## D2b.5: diff navigation and context selection

I need to inspect the whole change and select useful source without squeezing the project into a small context bundle.

- Page changed-file lists and diff hunks by immutable candidate identity. Keep full bytes accessible when a preview is shorter. Preserve paths, modes, additions, deletions and binary status. Include clear loading, complete and unavailable states.
- Replace small aggregate context bundles with immutable selections and range retrieval. Show exact source, ranges and bytes. Assemble provider input against the route's observed context capacity; report excluded or compacted material and preserve the underlying local content.
- Keep native selection in desktop main and read authority in the controller. Context supplies no extra filesystem or command authority. Separate local content size from measured provider token/context usage.

Primary boundaries: source/changes reads, `apps/controller/src/conversation/context.ts`, artifacts, contracts, client and source/context/diff views. Reuse the large-content path from D2b.2 and source manifests from D2b.3.

Acceptance: inspect a candidate with more than 200 changed files and a diff larger than 1 MiB, including its last hunk, without losing records. Capture a folder selection beyond 32 files and a source range beyond the old 8 KiB file bound. Verify exact selected hashes and ordering after reopen. Use offline provider fixtures to prove context-window admission, explicit exclusions and cancelled retrieval. Local access to a full file does not prove that every byte was sent to inference.

## D2b.6: commands, output and cancellation

I need project test, lint and build commands that produce durable results and stop when I ask.

- Add explicit executable/argv command definitions rooted in the task's scratch. Scope environment, working directory, network and filesystem authority. Avoid concatenated shell strings by default. A command that needs a shell states that executable and authority plainly.
- Journal intent before spawn, own every child phase and close every stream. Stream output to artifacts with small display pages and a final byte/hash census. Retain nonzero exits, timeouts and truncation or disk failures as failures with a next action.
- Expose command selection, running output, Stop and final results through normal task controls. Project commands run ordinary local code under the stated native trust boundary; they do not gain containment from being in scratch.
- Separate exploratory command output from trusted check evidence. Promote a command into a verification recipe only with frozen evaluator authority and explicit success criteria.

Primary boundaries: controller-owned command module, existing host/process journals, artifacts, contracts, CLI and task output views. Do not add a renderer shell or a second process scheduler.

Acceptance: run real project lint, tests and build; preserve a failed command and more than one frame of output. Exercise Unicode, hostile output, a child holding stdout open, cancellation and controller loss around spawn. Reopen without replaying an ambiguous command or declaring an unknown owner closed. Prove the original checkout and ungranted paths stay unchanged in the supported trust profile.

## D2b.7: practical multi-file changes and tests

I need one ordinary change spanning implementation, its tests and configuration to reach a checked result.

- Audit the existing repository profile first. Reuse its scratch capture and whole-candidate review. Keep profile-specific single-file restrictions visible; a combined two-child workflow need not be widened to enable one repository writer.
- Support coherent multi-file additions, edits, renames and deletions, with navigable diffs and the exact affected source set in review. State binary, submodule and generated-file support honestly.
- Freeze independent evaluation authority separately from editable project tests and configuration. A legitimate test change must be evaluable; it cannot silently replace the trusted grader, shrink required coverage or qualify itself through an exit-zero wrapper.
- Bind check and review evidence to the final candidate, toolchain, command definition and collected test identities. A dependency or lockfile change requires an explicit dependency preparation policy and isolated installation authority, never an ambient network install.

Primary boundaries: repository preparation/capture and evaluation in the controller, `apps/controller/src/host/worker.ts`, `apps/controller/src/host/toolchain.ts` and process ownership helpers, contracts and changes/evaluation UI. Retain the current fixed recipes and historical evidence definitions.

Acceptance: finish a real backlog change across at least five files with an implementation change, changed project test and configuration change. Add a meaningful regression assertion and demonstrate it failing on the old source. Run the unchanged independent acceptance checks and candidate project tests, then review, accept and reopen. A second small fixture changes a dependency declaration and lockfile; qualification requires its explicit preparation path, or records that capability as unfinished and splits it into a follow-up slice. Preserve sibling work and the original checkout/index.

## D2b.8: checked branch, push and PR

I need a checked result to reach the remote repository with enough evidence to review it there.

- Reuse local candidate acceptance. Add separate destination-bound effects for commit when required, push and PR creation/update. Bind them to repository identity, accepted commit/tree, remote URL, branch and current expected remote state.
- Show the exact publication plan before authority is consumed. Preserve local identity and DCO rules. Do not overwrite an existing destination or force-push through a normal retry.
- Persist an operation intent and reconcile remote effects after uncertain completion. A timed-out push or PR create is unknown until an exact remote read establishes the result. Never replay a mutation solely because no response was seen.
- Link required CI status and complete logs to the published head. Keep merge, deployment and Actions dispatch as distinct effects with their own authority; creating a PR grants none of them.

Primary boundaries: accepted-result publication, the command/GitHub operation modules, contracts, CLI and approval/task views. Keep the old local-branch acceptance behavior available.

Acceptance: in an authorized disposable repository, publish an exact checked commit to a new branch and create its PR through the normal product flow. Observe a failed CI run, retain its logs, fix the issue as a new checked candidate and update the PR without rewriting unrelated work. Reconcile duplicate retries, an existing branch, a changed remote head and a lost response after a remote effect. Subscription inference authority supplies no credential or remote mutation authority.

## D2b.9: restart, updates and trusted verification

I need yesterday's accepted work to remain readable after an update, with its original proof intact.

- Cover restart before intent, after intent, during spawn, after child exit, during output publication, during local ref publication and after a remote effect with no response. Known never-launched and outcome-unknown remain separate.
- Version stored evidence and verification definitions. Retain the data needed to validate completed proof after paths or application files change. Validate old proof without executing a saved runtime or signaling a historical PID. New checks use a trusted current definition or an explicitly installed, pinned compatible evaluator.
- Make pending evaluation across an app update actionable. Keep the candidate and completed contribution; explain whether it can continue with matching authority or needs a new evaluation definition. Repreparation cannot silently relabel old proof or request another model contribution.
- Validate migrations, backups and rollback before touching a real home. Keep old artifacts readable; fail safely on corruption, disk pressure and missing dependencies. Update the normal GUI and CLI errors with the actual unresolved state and next safe action.

Primary boundaries: numbered store migrations, receipts, evaluator identities, process journals, publication reconciliation, packaged runtime manifests and continuity UI. A schema migration belongs to the integration owner. Follow [ADR 0007](adr/0007-recover-from-durable-facts.md) and [ADR 0004](adr/0004-sqlite-state-and-immutable-artifacts.md).

Acceptance: complete a task in the prior published package, update a copied home to the candidate, inspect its exact conversation, candidate, checks and accepted branch, then perform a fresh supported task. Exercise pending checks and uncertain publication separately. Confirm no duplicate provider call, command or remote effect. Downgrade only through a documented compatible path or restore a validated pre-update backup; never open a newer writable schema blindly.

## D2b.10: daily-work acceptance

I will claim support only for the profiles, sizes and workflows this suite actually observes. Passing fixtures is necessary. Real work establishes whether the workflow is useful.

| Scenario | Required evidence |
|----------|-------------------|
| Large repository | Registration, contextual read, useful edit, complete diff, checks, review, branch acceptance and reopen at the declared scale |
| Multi-file change | Implementation, tests and configuration change together, with independent regression checks and exact whole-candidate review |
| Project commands | Successful and failed lint/test/build commands, complete retained output, cancellation and positive process closure |
| GitHub cycle | Branch, commit, push, PR, failed Actions job, full log, fix and green required checks on the exact final head |
| Interruption | Stop and controller restart with active work, a preserved candidate, no duplicate effect and explicit recovery |
| Application update | Completed and pending work reopened across versions with honest trusted-evaluator compatibility |
| Concurrent work | A large read or check leaves another task's status and Stop usable; sibling source and authority remain separate |

Use at least two representative repositories: one large project and one existing daily project. Use a real backlog issue, not a predetermined provider patch. Include Local enabled and disabled where that feature is claimed. Record elapsed and active time, failures, manual repairs and occasions when I had to finish in another tool. A claim about a route requires evidence for that route; one family cannot qualify every client. Keep the suite repeatable through normal desktop/CLI controls without private database repairs or supervisor-only escape paths.

Before closing this slice, resolve every correctness, durability and daily-work blocker found in the matrix. Record usability follow-ups explicitly. Passing this suite qualifies the stated coding scope. It does not establish general equivalence with every coding product, every repository or every provider feature.

## D2b.11 and D2b.12: local history modes

Instant History keeps the conversation, tool, attachment and result content CrewKite actually receives locally. Page and index that history, virtualize the view and prefetch nearby sections. Opening an old task should display its latest content from disk without waiting for a remote download. Separate cloud-app history requires a supported import or access path; this feature creates no such access.

Measure cold open, warm open, scrolling and memory use on a large retained home. Start with a 1,000-task, 100,000-event fixture and set latency targets from a recorded baseline on the target machine before implementation. Report first-content and requested-range latency separately. Preserve search, ordering and task identity through restart. A fast empty view does not count as fast retrieval.

Optimized Storage compresses older immutable sections independently. Start with a configurable age threshold, such as seven days, while keeping recent content and indexes readily available. Decompress the requested section off the UI thread and cache nearby sections. Show progress and corruption clearly. Changing modes must preserve content and be resumable after interruption. Keep original bytes until the replacement section is durable and verified. Test power-loss boundaries, low disk, checksum failure, decompression expansion and mode reversal. Report storage saved and cold/warm retrieval cost.

The page contract and local indexes come from earlier slices. Choose segment size and compression only after measuring real history; record a new Proposed ADR if that choice changes storage ownership or format. History polish does not postpone released coding slices.

## Implementation and release contract

For each slice:

1. Inspect main, the latest release receipt, open worktrees and dirty files. Preserve existing work. Record the gap, scope and acceptance before coding. Start a neutral `<type>/<kebab-topic>` branch from the current reviewed base.
2. Trace the affected flow and its current tests. Keep contracts, migrations, lockfile and entry points under one integration owner. Update only the docs whose behavior changed. Never edit an Accepted ADR; propose a successor for a changed decision.
3. Implement one useful vertical slice. Run focused checks for its named claims and an independent diff review. Reuse existing table-driven claims when they cover the boundary. Keep tests deterministic and local. Injected schedulers must run follow-up callbacks and cleanup with the same ordering guarantees as production timers. Exercise controller responsiveness under concurrent reads, commands and cancellation. Connected qualification is separate and needs its existing authority.
4. Commit only the owned changes, with a moderate Conventional message and DCO sign-off. Run policy, links/anchors and the full required `pnpm verify` for the exact final source. Preserve failed evidence. Pass every required PR check before the integration owner squash-merges; no direct main push or check bypass.
5. Capture the merge commit and tree. Verify that exact source again through the trusted release path, then stage a fresh normal macOS arm64 package with `scripts/package.mjs` as described in distribution. Use a new ID such as `d2b-01-uat-01`. Bind source, runtime/tool identities, verification and inventory/notices. Never reuse an old receipt for changed bytes or overwrite a prior package.
6. Archive the pristine package before opening it. Extract that exact archive into a separate proof directory. Check normal cold launch, task controls affected by the slice, normal Quit, same-home reopen and positive process closure. Compare immutable package assets before and after. Preserve original homes and never bundle a developer home, credentials or private logs.
7. Publish the source and a separate UAT prerelease through the authorized repository path. Attach concise instructions, a sanitized release receipt and archive checksums. Download the published archive and verify its hash. State signing, OS compatibility and route limitations from actual evidence. A runnable directory preview is not an installer or clean-machine qualification.
8. Update the progress row with source, CI, package URL, checksum and observed acceptance. State the next slice and any real blocker. Keep the prior working package available. Any deployed service affected by a slice gets its own authorized deployment and health proof; these desktop slices do not imply a hosted-service deployment.

For a source rollback, make a reviewed revert commit and rerun its matching checks. For a package rollback, keep the previous immutable download and its receipt. For data rollback, restore a validated backup or use an explicitly tested compatibility path. Preserve uncertain operations and their receipts so rollback cannot replay them.

## Authority and remaining decisions

Read volume and product size are separate from authority. Streaming can carry large projects while process ownership, permissions, provider context windows and admission budgets stay enforced. Do not replace a fixed aggregate byte ceiling with hidden truncation. Resource failures need a durable reason and recovery action. [Proposed ADR 0027](adr/0027-page-large-data-without-project-size-ceilings.md) and [Proposed ADR 0028](adr/0028-journal-project-commands-and-remote-effects.md) describe those choices; their status grants no command or external effect.

This work uses existing ordinary subscriptions only. No paid-credit fallback, purchases, account changes or new live provider campaign are authorized by this plan. Use offline fixtures for development and preserve current route qualification. Credential setup, external mutation and deployment use concrete authority for the named destination and action. Authorization already given in the active work remains valid within its stated scope; this plan adds no repeat approval step for that same action. Source inspection must never become an ambient credential read.

The first two releases establish throughput. Their measurements will determine whether later rows need smaller releases. D2c is optional stabilization driven by observed UAT. A final polish pass does not absorb unfinished coding acceptance, and D3 remains a separate decision.
