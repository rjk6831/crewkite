# Architecture

This page describes the current design. The reasoning behind each choice is in the [ADRs](adr/README.md).

## Components

| Component | Owns | Does not own |
|-----------|------|--------------|
| `apps/controller` | State, policy, routing, provider adapters, execution host, artifacts, evidence | Trust in model output as authority |
| `apps/desktop` | Electron main and preload, React renderer, native pickers, a narrow bridge to the client | Database access, provider launches, arbitrary shell or file APIs |
| `apps/cli` | Human commands, JSON output, offline diagnostics | A second permission, acceptance or database write path |
| `packages/contracts` | Runtime schemas, state and reason vocabularies, fixture contracts | Electron, database or provider code |
| `packages/client` | Handshake, typed commands, reconnect and replay, bounded reads | Domain transitions, provider protocols |
| `packages/testkit` | Fake provider executables, synthetic repositories, injected clocks, fault fixtures | Any production inference route |

Provider adapters stay inside the controller until a second consumer needs them. One integration owner lands changes to contracts, migrations, the lockfile and entry points, so the packages never drift apart.

## Processes and transport

The controller runs as one headless Node process per user. The desktop app and the CLI connect to it over a private Unix domain socket using length-prefixed JSON frames with a size limit.

- The socket lives in a directory only the user can read. Each connection presents a token from a user-only file during the handshake.
- The controller binds the actor to the connection. A caller-supplied actor ID is correlation data only.
- Provider processes and workers never receive the socket path or token.
- Clients that speak a different protocol version are rejected.

These measures keep other clients and workers off the control channel. They do not defend against malware running as the same user, and the docs make no such claim.

Native writer preparation includes per-phase ownership hooks and a SQLite journal for preflight and task processes. The journal separates launch intent, the actual process group and proven quiescence. Recovery checks every recorded group; ambiguous ownership stays blocked, and no native phase restarts automatically. Native dispatch remains disabled.

## Commands and events

Every mutation carries a protocol version, an idempotency key, the expected entity revision and a validated payload. The controller stores a digest of each request with its receipt.

- Retrying the same key with the same content returns the stored result.
- Reusing a key with different content is rejected.
- A stale revision returns `stale-revision` with the current state.

Results use a finite set of outcomes: `applied`, `already-applied`, `stale-revision`, `denied`, `unsupported`, `blocked` and `outcome-unknown`. Each carries a reason code and the safe next action.

Reads use snapshot plus subscription. `GetSnapshot` returns state at cursor C, and `Subscribe` replays ordered events after C. A gap in retained history forces a fresh snapshot. Slow clients are disconnected and resync; they never hold up work.

The current D0 controller runs scripted routes. `ExportDiagnostics` returns `unsupported`. Live provider qualification and installed-package recovery remain separate gates. The table describes the first-release command contract.

The command set for the first release:

| Command | Contract |
|---------|----------|
| `RegisterProject`, `InspectSource` | Explicit path selection, base revision, bounded dirty and untracked file details, stable project ID |
| `CreateTask`, `AmendTask`, `PrepareRun` | Saved criteria, versioned amendments, a frozen preview of source, routes, checks and limits |
| `StartRun`, `GetSnapshot`, `Subscribe` | Atomic admission, consistent state with ordered events, no duplicate dispatch |
| `SwitchRoute` | Save an allowed coder target, stop the outgoing writer, seal retained work and recheck normal admission |
| `PauseAdmissions`, `StopRun` | Pausing stops new dispatch. Stopping requests cancellation and waits for proven quiescence |
| `ResolveApproval` | Binds the exact pending action, target, attempt, generation and revision |
| `GetChanges`, `GetArtifact`, `GetUsage` | Bounded reads of immutable content and sourced usage observations |
| `AcceptCandidate` | Eligible candidate, current authority, an unused destination ref, idempotent publication |
| `GetHealth`, `ExportDiagnostics` | Runtime and qualification state, redacted export after preview |

The controller exposes registered project and artifact IDs. It exposes no generic exec, raw path, URL fetch or credential command.

## State

Current-state tables in SQLite are authoritative. An ordered event log explains each transition. Large outputs and source snapshots are immutable files addressed by hash.

| Entity | Meaning |
|--------|---------|
| Project | A registered repository with stable identity |
| Task | A bounded outcome with acceptance criteria |
| Run | A frozen revision of a task and its resolved policy |
| Attempt | One dispatch to one route, with a generation number |
| Route | A qualified combination of client, account, model, effort and billing mode |
| Observation | One usage reading for one route window, with source and time |
| Reservation | Capacity the controller holds for admitted work |
| Approval | A pending or resolved decision bound to one exact action |
| Artifact | Immutable content: diffs, logs, snapshots, handoff packets |
| Candidate | A sealed set of changes with a content hash |
| Receipt | The durable record of a command or effect |

A task moves through these visible states:

![Task states from draft through running, waiting, handoff, stopping, recovery, checking and acceptance.](images/task-states.svg)

`unknown` blocks sealing, takeover, cleanup and acceptance until the controller proves no writer remains.

## Admission

Admission is one short SQLite transaction that runs before any provider I/O:

1. Compare the task revision and the caller's authority.
2. Reserve every hard counter and the completion allowance the policy needs.
3. Acquire the writer lease for the task.
4. Record the launch intent, advance state and store the receipt.

The process spawns after the commit. If the controller restarts with an intent that has no acknowledgment, the attempt becomes `outcome-unknown`. Nothing replays it automatically, and nothing refunds reservations on a guess.

Read requests validate their payloads and return current state without storing mutation receipts. Launch intents retain admission and observed completion times. The scheduler enforces the remaining wall-time budget while each process runs. Whole-minute charges round up. Missing or invalid timing keeps the full allowance charged.

An acknowledged process group keeps that provenance across restarts while ownership is unknown. Once the recorded group is absent, recovery charges through the current recovery time as an upper bound and marks the task interrupted. Recovery never signals a recorded PID or starts a successor. An unacknowledged intent remains ambiguous.

## Execution and source safety

Each writer works in an independent scratch copy of a selected committed base. The copy has no shared writable Git metadata, hooks or ambient configuration from the source repository.

- Dirty and untracked files in the user's checkout are disclosed, preserved and left alone.
- Traversal, collisions, unsupported symlinks, submodules and unexpected file modes are rejected with a reason.
- Stopping forwards the client's native interrupt and waits for evidence that every owned writer has exited. A child exit code or a quiet directory alone is not that evidence.

Source inspection returns at most 200 changed file entries and 64 KiB of encoded details, with omitted counts. Entries contain relative names, status and staged or unstaged flags. The preview contains no file contents. These display details are separate from the frozen source identity. Inspection compares raw file bytes and executable modes with the index. Clean filters and line-ending conversions can make a transformed checkout appear changed. Inspection does not run those filters. Git reads disable hooks, filesystem monitors, replacement objects and lazy fetches. Missing committed objects block preparation.

The current host uses Unix process groups and requires closed output streams before it releases ownership. Missing proof blocks checks and publication. Source copies reject links, devices and named pipes before reading them.

## Evidence and acceptance

After quiescence, the controller imports the scratch changes, hashes them and stores an immutable candidate. Checks and reviews bind to the exact candidate hash, check definition and evaluator. Changing one byte, shrinking the collected test set or altering the evaluator invalidates the evidence that depended on it.

D0 checks qualify the fixed synthetic `netMinor` definition. The original test file hash, required file-qualified test completions and reporter identity are part of the check definition. An import that exits before registering tests cannot establish a pass. Other repositories can be registered and inspected; their checks are unqualified.

Newly resolved Quick quality requires declared checks and `keep-it-simple`. Standard adds `second-opinion`; Thorough adds `challenge-assumptions`, in that order. Second opinion requires the Reviewer role. Simplicity and assumption challenges permit Reviewer or Advisor. Same-route or same-family reviews establish process independence only. New Round-robin selection waits for an explicit ordered review panel; approved fallbacks do not authorize every backup to run. Stored runs retain their frozen methods and evidence bindings. Quick without a selected independent review labels that absence. These jobs inspect fixture patterns. They provide no model judgment or live provider qualification.

New review jobs bind the last stopped writer's attempt and route to its exact candidate receipt before dispatch. The same binding is checked when evidence is reused or accepted, including when two writers produce identical bytes. A different route does not establish model diversity. Older jobs without writer identity retain their original definition and show unknown provenance.

A handoff carries its task's candidate bytes, changes and retained evidence by immutable identity. Writer generations advance on writer transfers. Check and review jobs consume the same run's attempt and minute budgets without advancing writer generation. Explicit coding recovery captures current retained bytes into a fresh packet and labels unverified work.

A prepared draft can be edited only before its current run has attempts, allocation or unresolved work. Preparing again creates a new frozen run and keeps the old audit history. It does not start work or reuse approval.

A scratch grant allocates one workspace for one bounded run. Every successor still passes admission. Check and review dispatch freeze the candidate, evaluator and one-use authority. Stopping closes unresolved approvals. Resolving an export restores the task's prior state, including an already accepted publication.

Publication writes an immutable prepared pack before recording its effect. Acceptance imports the exact commit and candidate tree and verifies the original parent. D0 publication supports SHA-1 repositories. Export returns an immutable patch artifact; native save is a client action.

Accepting a candidate creates one new local branch in the source repository with create-if-absent semantics. Existing refs are never overwritten. After a crash, the controller reconciles the exact prepared ref before it reports `already-applied` or a conflict. Acceptance never merges, pushes or deploys.

Snapshots and frames are bounded. Replay beyond 1,000 events requires a fresh snapshot. A check or review interrupted during execution cannot be resumed as a new coder. Its retained work remains inspectable and exportable; preparing a new bounded run is explicit.

## Desktop security

Main loads bundled renderer assets through an allowlisted application protocol. The window uses sandboxing and context isolation, with no Node integration. Its CommonJS preload exposes payload-only callbacks and finite capabilities. Main validates the invoking window, main frame, exact page URL and shared payload schema for each request. Browser permissions, new windows, downloads and navigation are denied. Provider content renders as text.

One authenticated socket client in main serves the renderer. Main supplies command identity and keeps bounded replay while the page loads. Missing history remains visible after a snapshot repairs current state. Uncertain mutation receipts belong to the selected profile and retain their exact keys and content for explicit retry. Reconnection never resumes a run.

Project registration uses a parented native directory picker. Generic renderer commands cannot supply a registration path. Export remains a controller effect: main reads the returned immutable artifact, verifies its length and checksum, then offers a parented save dialog. A saved patch uses an unused destination and durable file and directory writes. Cancellation keeps the artifact available. The CLI receives the artifact result independently of desktop saving.

The demo has an explicit bootstrap with a persisted fake catalog and a separate private home and profile. Main verifies the standalone Node version, platform, architecture and checksum before launch. The staged runtime resolves fixed entries inside its package. A connected source journey does not establish installed recovery.

## Repository layout

```text
apps/
  controller/   headless controller: store, domain, routing, continuity, host, providers
  desktop/      Electron main, preload and React renderer
  cli/          command-line client
packages/
  contracts/    schemas and vocabularies shared by every process
  client/       socket client used by desktop and CLI
  testkit/      fakes, fixtures and the synthetic repository
docs/           public documentation and ADRs
scripts/        repository policy checks
```
