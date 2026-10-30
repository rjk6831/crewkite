# Architecture

This page describes the current design. The reasoning behind each choice is in the [ADRs](adr/README.md).

## Components

| Component | Owns | Does not own |
|-----------|------|--------------|
| `apps/controller` | State, policy, routing, provider adapters, execution host, artifacts, evidence | Trust in model output as authority |
| `apps/desktop` | Electron main and preload, React renderer, native pickers, a narrow bridge to the client | Database access, provider launches, arbitrary shell or file APIs |
| `apps/cli` | Human commands, interactive terminal mode, JSON output, offline diagnostics | A second permission, acceptance or database write path |
| `packages/contracts` | Runtime schemas, state and reason vocabularies, fixture contracts | Electron, database or provider code |
| `packages/client` | Handshake, typed commands, reconnect and replay, bounded reads | Domain transitions, provider protocols |
| `packages/testkit` | Fake provider executables, synthetic repositories, injected clocks, fault fixtures | Any production inference route |

Provider adapters stay inside the controller until a second consumer needs them. One integration owner lands changes to contracts, migrations, the lockfile and entry points, so the packages never drift apart.

![Desktop conversation and CLI share durable state, authority gates and owned provider connections.](images/controller-overview.svg)

A fresh normal workspace has no seeded project or fixture route catalog. Its prepared native profiles and explicit Local connection use their real provider protocols. Developer demo and preview modes remain explicit. A failed native operation retains its own refusal or uncertainty; it grants no fallback authority.

## Chat thread

A thread is one conversation about one project. The first message creates the task record, and every later message belongs to it. The controller keeps the thread's base commit, the current provider and model, a permission policy, and one native session ID for each provider that has run on the thread.

A turn is one user message and the provider's response until it yields. A thread runs one turn at a time, and a turn has a thirty minute deadline. The turn is the unit of Stop and process cleanup. It ends as done, stopped or failed. A usage-limit refusal ends as failed, with the reset time on the failure when the provider reports one.

A message sent during a turn waits in the thread record, up to eight of them, and joins the conversation only when it starts. When the turn ends, the oldest one starts on the thread's current provider and model, so a handoff in between carries it along. Stop clears the queue and the composer gets the text back. A usage limit on the newest turn holds the queue, since the next message would stop on the same limit. It starts again after the person continues on another provider or sends another message. A provider process that outlived its turn holds it until a later send or a restart finds the process gone. Queued messages survive a restart and start once the thread is free. `ConfigureChatThread` with `dequeue` takes one back. The composer offers Challenge assumptions next to Review changes and Second opinion. It runs one read-only turn on a model picked for it, with a brief that asks for the assumptions behind the last answer and the evidence that would settle each one.

An adapter owns one native process or connection for one turn. Each implements `ChatAdapter` in `apps/controller/src/chat/adapter.ts`: `startTurn` returns a handle with `respondPermission`, `stop`, the process groups the controller has to prove absent, and a `result` promise. Adapters are the only code that knows a provider's protocol. [Provider routes](providers.md) names the transport of each.

```text
renderer ---- SendChatMessage ----> controller
                                      one turn at a time per thread
                                      scratch copy of the base commit
                                            |
                                            v
                                         adapter <----> provider client
                                            |
                                     AgentEvent stream
                                            |
                    event log <-------------+-------------> renderer
renderer ---- ResolveChatPermission ----> controller ----> adapter
```

Adapters emit the `AgentEvent` values defined in `packages/contracts/src/chat.ts`: turn start, text and thinking deltas with one completed event per item, tool start, output and completion, permission requested and resolved, context usage, turn stats, context compaction, provider notices and turn completion. Unknown client methods go to a trace file in the turn's work folder and never reach the thread. The controller validates each event, appends it to the event log under the task and forwards it to clients as `agent.event`. An event it cannot read becomes one provider notice per turn and never ends the turn. The renderer folds the stream into messages and cards and knows nothing provider-specific. A view that opens in the middle of a turn rebuilds it from the log. The controller also emits `chat.turn` and `chat.thread` when those records change, and `conversation.entry` for each stored message. `chat.catalog` marks the end of a model read, with the number of models it stored or the reason it failed, so an open picker reads the catalog again.

The first turn copies the committed files of the project's HEAD into a scratch directory under the controller home, and that commit becomes the thread's base. A link whose target stays inside the repository is copied as a link. Submodules, links that lead outside and paths that are not UTF-8 stay out of the copy, and the controller lists them. Every adapter runs with the copy as its working directory. Anthropic and Local turns get the instruction files at the copy's root in their system context, up to 64 KiB, because neither client loads them there. OpenAI and Google read their own. Changes compares the copy with the base commit and honors the base's ignore rules. The person's checkout is never written. Edits leave the copy only through branch acceptance under [ADR 0008](adr/0008-isolated-writers-local-branch-acceptance.md), from the Changes tab. Acceptance builds the branch on the thread's base whatever HEAD is now. Links and every entry the copy left out go into the branch as the base has them. The base then moves to the accepted commit. A ref at `refs/crewkite/threads/<task>` in the project repository points at the current base, so the base survives garbage collection after the person deletes an accepted branch. Writing it changes no working tree, HEAD or branch, and deleting the thread removes it. Discard puts one path of the copy back the way the base has it, remakes a base link the copy changed and refuses entries the copy never held. Changes lists at most 2,000 entries, and Accept refuses when more files changed than the list holds, naming both counts, because it publishes only files the person could review. This is a size cap under [ADR 0027](adr/0027-page-large-data-without-project-size-ceilings.md). I plan to page the Changes list in sprint 2 and lift it. Pushing that branch and opening a pull request are separate clicks under [ADR 0037](adr/0037-push-and-pull-requests-from-the-changes-tab.md).

A permission request is an event in the thread. The adapter asks with the provider's own question and a list of options: allow once, allow for this thread, deny. The thread view shows it inline and `ResolveChatPermission` answers it. The controller accepts an answer only for a request that is open on the active turn, and only with an option that request offered. It then hands the answer to the adapter, which passes it through the provider's native approval channel. Model text cannot answer a request, which keeps [ADR 0002](adr/0002-authority-in-deterministic-code.md) intact. The thread's permission policy sets what an adapter may answer for itself: ask each time, allow edits or allow all. A new thread asks every time.

A failed turn keeps a failure record: the stage, a kind, one sentence saying what happened, the provider's own message and method when it has them, and the next action. The thread shows it as a system line. `protocol` is a kind for the record and is never the text the person reads.

`HandoffChatThread` moves a thread to another provider. The controller never asks the stopped model to summarize its own work, in line with [ADR 0007](adr/0007-recover-from-durable-facts.md). The next turn's first prompt is built from stored facts: the last 60 messages of the transcript, with user messages verbatim, the last three assistant answers in full and earlier answers cut to 600 characters, the changed files with their line counts, and the new message. The new provider reads the files itself in the same scratch copy. The earlier provider's session ID stays on the thread, so moving back resumes it when that provider allows.

## Scratch copies

The first turn on a thread fills its scratch copy from the thread's base. When the checkout sits on that base and Git reports no change to a tracked file, a regular file whose size matches the committed copy is cloned from the checkout, on a volume that supports copy-on-write clones. The controller hashes each clone as a Git blob and compares it with the committed object ID, and a mismatch is replaced with the committed bytes. Every other file is read from Git in runs of at most 32 MiB, and a single file larger than a run streams straight into the copy. A copy of more than 100,000 files is refused with its own message.

Changes, Discard and Accept compare by object ID and read only the changed files. A comparison reads at most 64 MiB of changed files for its patches. A changed file past that shows a "Not compared" note, and Accept still takes it.

## Plan slices

A plan from the orchestrator runs as the controller decides ([ADR 0045](adr/0045-the-orchestrator-proposes-and-the-controller-assigns.md) and its parallel amendment). The orchestrator proposes the plan and never picks which slice starts. Slices whose dependencies are done start together, each in its own scratch copy made from the thread's base and brought up to the thread's copy. At most one turn runs per provider family across all threads, so ready slices on one family run in plan order. Each slice runs the review chain with the same caps as a crew.

A finished slice replays onto the thread's copy in plan order. The comparison uses blob IDs and modes. A changed path is a conflict when the thread's copy holds neither what the slice started from nor the slice's own version. The slice then shows as Blocked with those paths, its other paths merge, and the orchestrator's model gets one fixer turn in the thread's copy with the conflicting versions quoted. A failed or stopped step stops the plan, and a slice can then run again from a fresh copy. After the last slice, the enabled project checks run on the thread's copy, and then the challenger runs.

## Project checks

The controller finds check commands in `package.json` scripts, `pyproject.toml` tool tables, Makefile targets and a `Cargo.toml`. Each one starts off. A command the person adds is accepted only as a program that runs in the scratch copy. Shells, wrappers such as `env`, inline code flags and paths outside the copy are refused.

A run needs the thread's permission for commands. The approval covers those commands and the script text behind them, so a changed script asks again. Checks run as local processes with the person's permissions, and nothing contains them. Balanced and Glide run the enabled checks after each fix and after the last slice of a plan. The full output goes to the artifact store, and the thread shows a redacted tail of the last 1,000 characters.

## Task conversation

The structured planning turn described in this section is retired. It sent the whole history to a read-only session as one prompt with an output schema and kept only a final answer that matched the schema. The [chat thread](#chat-thread) replaces it, and [ADR 0036](adr/0036-the-chat-thread-is-the-product-center.md) records why. The tables it wrote stay in the schema because migrations only append. The rest of this section records how it worked.


The task's primary conversation retains messages, queued guidance, questions, answers and proposed plans with their run and attempt bindings. A planning turn needs explicit consent, the supported primary profile and finite limits. The current selection permits Lead or Orchestrator through `openai-file-v1`, with a separate existing-credit choice. Requested model and effort remain distinct from observed effective settings. Planning consumes the task's budget; reading history, reconnecting and reopening admit no turn.

A completed planning turn can retain its bounded model catalog only after the reply is accepted and every owned phase is quiescent. The immutable artifact binds the task, attempt, supported profile and exact client identity. Its public projection reports last-observed choices and time, with no local path or account identifier. Reading the catalog admits no provider work. A changed client or invalid artifact makes the choices stale or unavailable.

Saving an exact advertised model and effort requires the existing quiescent configuration boundary. A material change records the observation reference and creates a linked future planning run without launching a provider or resetting the task's allowance. It returns the task contract to provisional, so execution preparation requires a fresh valid plan adoption. The next admitted turn rechecks the current advertised pair, account and credit policy, then requires exact model and effort acknowledgement before its prompt. Failure retains the request and leaves effective settings unknown. There is no fallback or automatic refresh. Without a saved request, the supported profile default remains available for the first turn.

The future execution policy control supplies a revision-bound preparation draft. The host checks its task and planning configuration before opening the real preparation form. Authority changes clear unsaved sharing and grant confirmations. Explicit preparation freezes the supported policy; opening or closing a draft grants nothing. Existing prepared and running work keep their frozen policy. Planning remains read-only and tool-free.

Adopting a plan binds its exact proposal ID and hash to the task contract. It grants no execution authority. Execution still needs its own prepared source, policy, permissions and Start. Guidance received during active work is retained for a later explicitly admitted planning turn. Model text cannot approve an effect, raise a limit or accept a result. The renderer projects current send and adoption availability from controller reads and keeps uncertain command receipts for exact retry.

Selected context is immutable input data. The controller captures committed source files or folders at the chosen base, and explicitly selected project-local logs from current disk bytes. It accepts up to four selections, 32 files, 8 KiB per file and 32 KiB for the complete encoded bundle. Links, unsupported text and excluded credential paths refuse. The artifact records the exact bytes, modes and hashes. The desktop's native picker keeps filesystem selection in main; its renderer validates the retained artifact for a content preview before the separate send decision. Capture retry resends the original command without reopening the picker; a committed result returns the same artifact. Conversation inputs reference those artifacts by ID and hash. Context supplies no filesystem, execution or approval authority. The composer shows only profile-supported controls. A context byte measurement cannot establish a provider token count or quota balance.

## Combined runs

A combined run freezes one parent and two child tasks from the same project and committed base. Each child owns one distinct existing text file and works in independent scratch. Preparation binds their task contracts, source, writer profiles, policy, selected tests and reviewer. The initial workflow uses Quick quality with one Keep it simple review under guided or balanced authority. Child work cannot be amended, transferred or accepted independently while that membership owns it.

The parent reserves seven dispatches: a baseline check, two writers, two ordered replay checks, a full final check and one fresh review. It needs at least seven attempts and two concurrent slots. Its minute allowance covers both writer maxima, the reviewer maximum, four one-minute checks and the explicitly selected private integration allowance. Omitting that selection retains the original one-minute allowance. Dispatches charge one shared ledger; child task limits remain additional gates. Earlier planning remains charged to its task. Missing closure keeps the reserved allowance charged. No stage receives an automatic retry or a larger budget.

The clean baseline must pass before either child can start. Assembly requires two substantive, in-scope candidates. It applies their exact deltas in order and checks each cumulative result before advancing a private integration ref with compare-and-swap. A durable operation journal owns the finite Git processes. Each Git operation has at most sixty seconds within the frozen aggregate integration allowance; ref reconciliation uses that same allowance. Active or unknown integration retains its full reservation. Completed integration charges its measured time, rounded up to whole minutes. The immutable origin binds both writers and candidates, source manifest, policy, criteria, replay definitions and results, and every old/new tree transition. Private integration changes no branch in the source repository.

The sealed combined candidate still needs an explicitly prepared full check and a separate native review of the whole result. Passing replay checks cannot replace that final barrier. The supported reviewer has its own source consent, credit choice and one-use grant within the parent's remaining allowance. Same-family review establishes process independence only. Destination-specific acceptance revalidates the complete origin and evidence chain before creating one new local branch. [Continuity](continuity.md#combined-ownership-and-recovery) describes parent controls and restart limits. [Proposed ADR 0026](adr/0026-bind-combined-acceptance-to-checked-origins.md) records the integration tradeoff.

## Processes and transport

The controller runs as one headless Node process per user. The desktop app and the CLI connect to it over a private Unix domain socket using length-prefixed JSON frames with a size limit.

- The socket lives in a per-user folder under the temporary directory, named for the user's ID. The controller records the socket it bound in `control-socket` in the home, and clients read the path from that record. A folder that is a link, is not private to the user or is someone else's is not used. The controller then binds in a fresh private folder beside it. A path longer than 100 bytes goes under `/tmp`.
- Each connection presents a token from a user-only file during the handshake.
- The controller binds the actor to the connection. A caller-supplied actor ID is correlation data only.
- Provider processes and workers never receive the socket path or token.
- Clients that speak a different protocol version are rejected.

These measures keep other clients and workers off the control channel. They do not defend against malware running as the same user, and the docs make no such claim.

Native writer preparation includes per-phase ownership hooks and a SQLite journal for preflight and task processes. The journal separates launch intent, the actual process group and proven quiescence. OpenAI task success requires its complete three-phase sequence. The Anthropic writer records authentication followed by the task process. Historical Google consumer pilots recorded a zero-turn configuration read followed by the task process, with the submission marker before spawn because the prompt was in argv. New consumer launches remain blocked. Each successful writer requires its exact provider sequence; reviewers retain the OpenAI sequence. Historical short OpenAI sequences remain readable for recovery; incomplete sequences cannot authorize a successful application or publication. Legacy cloud recovery checks recorded groups. A Local or ACP writer without terminal proof keeps an unknown outcome and settles once every recorded group is absent, as described below. The metadata rules below preserve missing closure proof as unknown. A supervised native file proposal uses `PrepareNativeRun` to save an immutable preview without provider I/O. `StartRun` rechecks its installed profile, scoped consent and source before entering the same admission and process owner. Each prepared writer permits one submission. Anthropic and Google preparation freeze a user-sourced ordinary-subscription billing attestation separately from native observations. Missing required evidence or attestation blocks submission. Google also freezes the expected native permission mode; fresh configuration must match it and report disabled credit fallback. Configuration success establishes no account or billing identity. The writer and supported OpenAI reviewer resolve by their own saved profile IDs. Retained native work can be inspected and exported. Route switching and scripted continuation stay unavailable. Optional manual file handoff uses a frozen recipient list, fresh explicit consent and separate preparation and Start after proven quiescence. It preserves the original pin, roles and limits. This path has offline fixture coverage only; Google consumer launch remains blocked.

One Anthropic file operation can continue after an exact first-party quota denial. The denial must carry a validated reset, complete with quiescent ownership and leave the task interrupted. Guided authority requires explicit Resume after that reset. Balanced persists one wake for the same operation. Autopilot does the same for supported standalone work; combined preparation rejects that mode. Controller restart restores one receipt-bound wake, and an elapsed reset enters normal admission immediately.

Within a combined run, only a denied native child slot reopens. The sibling must have passed with candidate provenance that still names its unchanged attempt, be stopped on its own exact confirmed quiescent denial, or be in intent or running for the immediately next generation backed by that same denial. Two wakes due at the same reset still pass through the existing concurrency gate. Successful sibling evidence and the original denials remain immutable. While waiting, the parent is blocked on incomplete writers. An admitted retry returns it to the writer phase, persists its exact current plan for new-generation evaluation, and leaves assembly unavailable until both writers pass. Retry admission rechecks the parent, member and slot ownership, source, profile, model, route, consent, scratch grant and remaining budgets. Stop of the parent or either relevant child, pause, integration activity, drift, expiry, revocation or uncertain ownership blocks it. Unknown, generic or active original work in the sibling slot cannot authorize a retry. The exact confirmed denial consumes no attempt or minute allowance. Success, generic errors and unknown outcomes retain normal accounting.

A separate repository profile prepares the complete committed source and explicit local-tool authority. The native client edits the independent scratch directly, using its workspace-write permission mode with approval requests and network access disabled. CrewKite trusts that client's permission system under ADR0009; it supplies no additional containment. The one-use scratch and native-tool grants are consumed together at admission, and the earlier expiry bounds execution. Native command and file-change activity is informational. It cannot establish a check result. After quiescence, the controller validates the resulting filesystem and captures its immutable candidate without reapplying a model response. Repository candidates honor the committed base's ignore rules while retaining tracked edits and deletions. A failed capture retains the scratch and reports interrupted, unverified work. An explicit Stop can recover a sealed repository candidate for evaluation when the original plan, submission, terminal record, stopped attempt and intent, quiescent phases, consumed grants, source scope and exact candidate still match. The controller saves those facts in an immutable recovery receipt and removes writer launch authority. Other partial work remains unavailable for evaluation. The existing file profiles and their application receipts keep their original behavior. This repository profile still needs connected qualification.

A separate candidate evaluation freezes its own scoped consent and reviewer assignment without changing the original run policy. The default recipe runs the trusted synthetic Node collection. An explicit project Node recipe selects up to 32 committed test files and freezes their exact bytes. Both run in an independent candidate copy through the existing local process owner. Passing checks retain evidence and wait for explicit `StartCandidateReview`. That command consumes the supplemental one-use review grant for one fresh native review within the original run's remaining attempt, minute and concurrency caps. The writer's fixed allowance is unchanged. Review input binds the immutable original and candidate bytes, task context, exact successful checks and reviewer profile. Repository review includes every changed text file, with explicit additions and deletions, and binds the whole candidate. Unsupported binary changes and an oversized review input remain retained and cannot pass that review. Review uses the same three-phase ownership journal and retains evidence only after quiescence. Same-family review establishes process independence only.

A native candidate becomes ready only after the exact checks and declared review method pass with proven ownership. Local acceptance revalidates the retained proof and current source through the existing publication path. Completed check evidence can survive a moved runtime when its saved definition digest is valid and the reporter bytes, evaluator, test collection, criteria and all other arguments are unchanged. The saved reporter path is never executed during publication validation. Pending checks and review starts keep exact current definitions. Expired inference consent or an unavailable provider account does not erase completed evidence. Creating a branch still requires its own current destination-specific acceptance grant or approval. The evaluation preview reports whether that local action can be requested; it grants no publication authority.

## Command-line client

`apps/cli` is a second client of the controller. It connects over the same socket and reads the same home record as the desktop, so a thread started in one shows in the other. With no subcommand on a terminal it opens an interactive mode, drawn with Ink on React. Otherwise it runs one command and can print JSON lines for scripts. It adds no permission, acceptance or write path. A permission answer must name an open request and an option it offered, Accept creates one new local branch, and Push needs confirmation. [The CLI guide](../apps/cli/README.md) lists its keys and commands.

## Commands and events

Google contracts separate the default-on quota read from ACP setup and frozen model selections. `ObserveUsage` requests a read with `{ family: 'google' }`, without a consent field or enable/disable toggle. Separate ACP setup commands initialize, authenticate, discover configuration and stop the current operation. Their revision is the persisted setup revision. Safe proofs retain client and capability identity without credentials or OAuth URLs. Typed one-use permission targets and inert ACP activity preserve existing string targets and text output.

Quota and ACP setup share a durable metadata-operation journal, separate from task attempts. Intent precedes spawn; ownership and closed streams bind the result to that operation. Active or unknown Google ownership blocks another metadata operation and native Google Start in that controller home. Every unfinished metadata operation remains unknown across restart, without probing or signalling its historical process group. Nothing replays. With the pinned client present, controller startup attempts one read. An authenticated client connection can refresh missing, stale or unknown windows. Each read has a twenty-second process bound. Startup and connection attempts have a sixty-second cooldown; connected interval attempts require 270 seconds since the prior attempt. Failures count toward these limits and preserve prior window timestamps. The complete account report remains visible. The frozen model selection determines applicable pools through the exact mapping in [provider routes](providers.md#google-quota-read); unknown pools retain conservative freshness and reserve checks. Missing required pools block admission. The quota-only row has unknown model and effort and remains unqualified. A read cannot enable a writer. A thirty-second Start preflight can refresh missing or stale quota once. Fresh exhausted quota refuses that refresh; final admission rechecks every applicable pool, configured reserve and current authority.

The server checks idle refresh eligibility every ten seconds while authenticated clients remain connected. It dispatches the supported Google and production OpenAI metadata readers without a model prompt. The OpenAI reader has its own durable intent and closure record, shared exclusion with real OpenAI work and an unqualified display route. It never refreshes historical task routes by family, client binary or matching values. Publication requires physical closure inside the original twenty-second monotonic and wall deadlines. A validated account reading can survive a later protocol refusal, but cancellation, close, deadline or unknown ownership prevents publication. Restart never replays a read. A read with no recorded group stays unknown. When every recorded group is absent, recovery releases the read and publishes nothing. It sends no signal to a saved group and only checks whether the group still exists. The scheduler supplies no freshness guarantee.

Owned OpenAI and Anthropic task reports enter through the current runtime, attempt, generation, lease and process phase. The controller attaches the exact route and receive time. Sparse updates preserve omitted windows, cached repeats keep their old timestamps, and complete reads replace only that route's client windows. Observations remain advisory. The existing native admission metadata checks and Google preflight keep their separate authority.

The ACP profile uses a separate task appointment and owned process phase. Preparation freezes its client pin, setup proof, configuration choices, source and explicit consent. Start reapplies the model, optional thought level and verified review mode before its single prompt. Production review-mode and edit-tool mappings bind one exact imported server/helper bundle, signer and version. Fresh setup proof must match that mapping; authentication and discovery alone grant no edit authority or route qualification. [Provider routes](providers.md#google-acp-writer) describes the fixed staging import and dated evidence.

An ACP permission request must map to one supported replacement. The complete action, including exact old and new text, must fit 4 KiB and remain bound by hash to one pending approval. A bounded hunk requires one exact match and binds the complete before and after file hashes. The controller rechecks the current target before approval and matches captured bytes to the approved result hash. A current human decision can select only the offered `allow_once` option for the exact session, tool call, task, attempt, generation and revision. The controller persists the decision before replying. Stop cancels pending requests and waits for the original prompt's cancelled response, closed streams and owned group absence. Missing terminal proof retains uncertainty and blocks capture. That unknown writer also closes the home's Google gate. The controller settles it once it proves every recorded process group absent, when the turn finishes or when it recovers after a restart. Only `ESRCH` counts as proof, and a phase still at launch intent proves nothing. An explicit Stop can settle an attempt left unknown after a restart on the same proof. The attempt keeps its unknown outcome and its submission, completion and phase records. The intent stops, the lease and reservations release, and the task becomes interrupted with a next step. Nothing is captured, and the run cannot submit again. Minutes are charged up to the quiescent time recorded for the last phase. Without that record, the charge ends at the earlier of the recovery or Stop time and the attempt's task limit plus a one-minute cleanup reserve.

The read-only task context is captured before Start, with a shared 64 KiB limit for its binding and complete retained patch. Private connector storage outside scratch binds it to the admitted run, source, policy, attempt, generation and configuration. Expected approval transitions preserve that capability; each read still validates the current owner. The provider receives no controller token. A completed writer captures actual scratch through a distinct receipt, with no second replacement application. The existing target must remain regular UTF-8 text within 64 KiB with its original mode. Every sibling path, byte and mode must match the admitted source. Provider diffs and connector sidecars remain activity, with no check, review or acceptance authority.

An ACP candidate uses the existing evaluation path with separate local-check authority. Its native reviewer still needs a supported OpenAI profile, scoped consent and grant, and remaining provider allowance within the original run limits. The Google writer's quota observations grant none of that reviewer capacity. Missing required review blocks acceptance.

Local setup stores a nonsecret connection revision, explicit authentication mode, model observation and selection. Dedicated-token mode is the default; its credential stays in controller memory and requires input again after restart. An explicit CLI configuration can select no authentication for the literal loopback endpoint on this device. Its nonsecret connection confirmation survives restart for the same configuration and requires no token prompt. Endpoint or mode changes and Disconnect revoke the old connection and model selection. The desktop displays the saved mode without choosing or downgrading it. Discovery lists installed variants and loaded instances without loading a model. Preparation binds the selected eligible instance and runtime metadata to the source and policy, with no cloud billing attestation or credit policy. A durable Local operation excludes input, discovery and generation from conflicting. Intent precedes launch; matching terminal proof and recorded client closure settle ownership. Uncertain ownership survives restart without replay or historical process signalling. A turn with no matching terminal keeps an unknown outcome. Once every recorded client group is absent, the controller settles it, releases the lease and reservation and marks the task interrupted. It captures nothing and never resubmits. A group that still exists keeps the generation unknown. A completed Local file candidate has its own immutable preparation, terminal, applied replacement and closure evidence. Evaluation rechecks that origin against the current run, source and candidate before shared fixed checks and a separate OpenAI review. Matching evidence still needs destination-specific approval for branch acceptance. Restart can validate completed evidence without a current Local credential or connection; it never resubmits the writer. Live model qualification remains separate. [Proposed ADR 0025](adr/0025-use-an-explicit-memory-only-local-credential.md) records the Local authentication boundary; cloud-provider credential handling stays separate.

Every mutation carries a protocol version, an idempotency key, the expected entity revision and a validated payload. The controller stores a digest of each request with its receipt.

- Retrying the same key with the same content returns the stored result.
- Reusing a key with different content is rejected.
- A stale revision returns `stale-revision` with the current state.

Results use a finite set of outcomes: `applied`, `already-applied`, `stale-revision`, `denied`, `unsupported`, `blocked` and `outcome-unknown`. Each carries a reason code and the safe next action.

Reads use snapshot plus subscription. `GetSnapshot` returns state at cursor C, and `Subscribe` replays ordered events after C. A gap in retained history forces a fresh snapshot. Slow clients are disconnected and resync; they never hold up work.

The candidate evaluation preview binds the current candidate and saved preparation to its check and review evidence. It shows the remaining original run budget and separate reasons for refusing each start action. Completed evidence stays visible after consent expires. Reading the preview creates no receipt or launch, and each start command rechecks current authority.

Explicit native profiles can propose a replacement for an existing committed text file through the desktop or CLI. Developer fixtures separately exercise legacy team routing. Its exact provider limits are in [Provider routes](providers.md). `ExportDiagnostics` returns `unsupported`. General live routing and installer recovery remain separate gates. The table describes the first-release command contract.

The command set for the first release:

| Command | Contract |
|---------|----------|
| `RegisterProject`, `InspectSource` | Explicit path selection, base revision, bounded dirty and untracked file details, stable project ID |
| `CreateTask`, `AmendTask`, `PrepareRun` | Saved criteria, versioned amendments, a frozen preview of source, routes, checks and limits |
| `GetTaskConversationState`, `GetTaskConversation` | Read a task's retained conversation; new messages go through the chat thread |
| `SendChatMessage` | Store a user message and start one turn on the selected provider and model, with the role the message asks for |
| `ResolveChatPermission` | Answer one open permission request with an option it offered |
| `StopChatTurn` | Interrupt the running turn through the provider's own protocol and wait for its processes to exit |
| `ConfigureChatThread` | Save the thread's provider and model, permission policy and automatic handoff setting |
| `HandoffChatThread` | Move the thread to another provider; the next message carries the handoff packet |
| `AcceptChatChanges` | Commit the scratch copy on the thread's base as one new local branch; the checkout stays untouched |
| `DiscardChatChange` | Restore one path of the scratch copy to the thread's base; Accept then carries only what is left |
| `ReadChatThread`, `ReadChatChanges`, `ReadChatCatalog` | Bounded reads of the thread, of the scratch diff against its base, and of the providers and models the composer can offer |
| `ReadChatInstructions`, `ReadChatPrompts`, `SaveChatPrompt`, `DeleteChatPrompt` | Read the instruction files at the copy root and the saved prompts that the desktop and the CLI share, and save or delete one prompt |
| `ReadDiagnostics` | Build the diagnostics bundle from the controller's home and store: versions, pinned client digests, saved settings, the end of the controller log, the last 200 events of one thread and system facts, all redacted. The desktop and the CLI write it to a new folder; the older `ExportDiagnostics` stays unsupported |
| `SupplyMcpServers` | Give the controller the person's MCP server set from the desktop. It is a read with no receipt, and the controller keeps the set in memory |
| `ReadExtensions`, `ConfigureExtension`, `RunExtensionCommand` | List extension folders and their slots, turn one on or off after its hash check, and run one declared command with an idempotency receipt |
| `RefreshChatModels` | Read the OpenAI model list through the client with no thread and no model turn. One read runs at a time, and a process group it leaves behind blocks the next one |
| `ConfigureLocal`, `BeginLocalConnectionInput`, `RefreshLocalModels`, `SelectLocalModel`, `DisconnectLocal` | Explicit loopback setup, private credential input and observed model selection under the persisted Local revision |
| `PrepareCombinedRun` | Freeze a parent and two scoped children, shared dispatch allowances, checks and reviewer without starting work |
| `AssembleCombinedCandidate` | Replay both retained child deltas through ordered checks and guarded private ref updates; seal a candidate for separate final evaluation |
| `PrepareNativeRun` | Freeze a controller-owned file or repository profile, its committed source scope, task text, explicit or matching saved consent and policy; perform no provider I/O |
| `PrepareNativeHandoff`, `StartNativeHandoff` | Seal retained single-file work for one previously allowed recipient with fresh consent, then consume that exact preparation once after revalidation |
| `PrepareCandidateEvaluation`, `StartCandidateEvaluation` | Freeze supplemental authority for a stopped native candidate, then run its exact selected check recipe once; retain checks without starting review |
| `StartCandidateReview` | Recheck the successful candidate evaluation and separate reviewer authority, then start one bounded native review without applying files or accepting the candidate |
| `StartRun`, `GetSnapshot`, `Subscribe` | Atomic admission, consistent state with ordered events, no duplicate dispatch |
| `SwitchRoute` | Save an allowed coder target, stop the outgoing writer, seal retained work and recheck normal admission |
| `PauseAdmissions`, `StopRun` | Pausing stops new dispatch. Stopping requests cancellation and waits for proven quiescence |
| `ResolveApproval` | Binds the exact pending action, target, attempt, generation and revision |
| `ObserveUsage` | Read Google quota under the shared ownership gate and cooldown; preserve prior observations on failure |
| `InitializeGoogleAcp`, `AuthenticateGoogleAcp`, `DiscoverGoogleAcp` | Run one explicit setup operation under the shared Google gate and persisted setup revision; retain safe proof without a task prompt |
| `StopGoogleAcpSetup` | Revoke the current setup operation by its exact ID and persisted revision, request owned cleanup and retain unresolved ownership |
| `GetChanges`, `GetArtifact`, `GetUsage` | Bounded reads of immutable content and sourced usage observations |
| `GetTaskActivity` | Bounded legacy pages of whole task events using an exclusive cursor, with no mutation authority |
| `GetTaskActivityPage` | Bounded activity pages with immutable body references for oversized retained events |
| `GetArtifactRange` | At most 64 KiB of claimed immutable content, explicitly unverified until complete checksum validation |
| `AcceptCandidate` | Eligible candidate, current authority, an unused destination ref, idempotent publication |
| `GetHealth`, `ExportDiagnostics` | Controller availability; provider qualification remains profile-specific and diagnostic export remains unsupported |

The controller exposes registered project and artifact IDs. It exposes no arbitrary shell, URL fetch or unrestricted file-read command. Public command payloads accept no connection credential value.

Artifact publication streams bounded chunks into an incoming file, computes SHA256 incrementally and flushes the completed file before publishing its hash. Cancellation or failure preserves existing artifacts. Native range readers verify the complete length and checksum incrementally before returning a whole-content proof. A displayed range supplies no such proof. The bounded legacy buffer APIs retain their 64 MiB ceiling; repository capture and provider-context limits are unchanged.

Large activity rows retain their exact original UTF-8 JSON and cursor. The controller streams SQLite byte substrings to an artifact and commits its mapping only after durable publication. Interrupted conversion can retry after reopen. SQLite still visits the original row internally; this is not incremental SQLite BLOB storage. Oversized subscription history triggers resync and remains accessible through activity pages. The desktop retains one activity page, cursor-only return navigation and one 64 KiB text page per opened body. Native verification and output reads leave Stop and status available. CLI output waits for a slow destination before fetching the next range.

## State

Current-state tables in SQLite are authoritative. An ordered event log explains each transition. Large outputs and source snapshots are immutable files addressed by hash.

I model work as projects and tasks. A project registers the root of one Git repository, tying committed source and any accepted result branch to that repository. A task keeps one objective, its conversation, scoped permissions and retained evidence together. Workspace names the local application view. It adds no separate container or permission boundary.

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

The normal workflow keeps planning, execution and acceptance decisions separate. This diagram summarizes those boundaries; it is not a second state machine or a claim that every profile supports branch acceptance.

![Task decisions from a project goal through owned work, retained evidence and explicit branch acceptance, with separate Stop outcomes.](images/task-states.svg)

`unknown` blocks sealing, takeover, cleanup and acceptance until the controller proves no writer remains.

## Admission

Task admission is one short SQLite transaction before task submission. A required Google quota refresh has its own earlier metadata intent and closure gate:

1. Compare the task revision and the caller's authority.
2. Reserve every hard counter and the completion allowance the policy needs.
3. Acquire the writer lease for the task.
4. Record the launch intent, advance state and store the receipt.

The process spawns after the commit. If the controller restarts with an intent that has no acknowledgment, the attempt becomes `outcome-unknown`. Nothing replays it automatically, and nothing refunds reservations on a guess.

Read requests validate their payloads and return current state without storing mutation receipts. Launch intents retain admission and observed completion times. The scheduler enforces the remaining wall-time budget while each process runs. Whole-minute charges round up. Missing or invalid timing keeps the full allowance charged.

An acknowledged process group keeps that provenance across restarts while ownership is unknown. Once every recorded group is absent, recovery keeps the outcome unknown, releases the writer lease and reservations and marks the task interrupted. A recorded quiescent time ends the charge. Without one, accounting uses recovery time up to the admitted limit and one cleanup minute, and never precedes the last observation that showed the process alive. Recovery captures no candidate, never signals a recorded PID and starts no successor. An unacknowledged intent remains ambiguous.

## Execution and source safety

Each writer works in an independent scratch copy of a selected committed base. The copy has no shared writable Git metadata, hooks or ambient configuration from the source repository.

- Dirty and untracked files in the user's checkout are disclosed, preserved and left alone.
- Traversal, collisions, unsupported symlinks, submodules and unexpected file modes are rejected with a reason.
- Stopping forwards the client's native interrupt and waits for evidence that every owned writer has exited. A child exit code or a quiet directory alone is not that evidence.

Source inspection returns at most 200 changed file entries and 64 KiB of encoded details, with omitted counts. Entries contain relative names, status and staged or unstaged flags. The preview contains no file contents. These display details are separate from the frozen source identity. Inspection compares raw file bytes and executable modes with the index. Clean filters and line-ending conversions can make a transformed checkout appear changed. Inspection does not run those filters. Git reads disable hooks, filesystem monitors, replacement objects and lazy fetches. Missing committed objects block preparation.

The current host uses Unix process groups and requires closed output streams before it releases ownership. Missing proof blocks checks and publication. Source copies reject links, devices and named pipes before reading them.

## Evidence and acceptance

After quiescence, the controller imports the scratch changes, hashes them and stores an immutable candidate. Repository capture applies the committed base's ignore rules before it reads generated files. A tracked path remains included when a rule matches it, and newly edited ignore rules cannot hide candidate work. Checks and reviews bind to the exact candidate hash, check definition and evaluator. Changing one byte, shrinking the collected test set or altering the evaluator invalidates the evidence that depended on it.

Before that hash exists, the controller formats the changed files Biome supports in scratch, using its own installed Biome and the committed base configuration, with network access denied and a ten second limit. It runs the formatter as an owned asynchronous process after the writer closes, so controller timers and Stop handling remain available. The candidate hash covers the formatted bytes, and the bounded `formatting` receipt names the files it rewrote and the formatter's version and hash. A source without a matching committed Biome version, a failed run and a timeout all keep the writer's bytes and record the reason. Checks, review and acceptance use only the final sealed hash. Combined runs skip the step because their recipe has no formatter. Provider progress notifications remain non-authoritative display events and do not satisfy terminal completion.

D0 checks qualify the fixed synthetic `netMinor` definition. The original test file hash, required file-qualified test completions and reporter identity are part of the check definition. An import that exits before registering tests cannot establish a pass. The explicit project Node recipe runs only the selected committed files. They must remain unchanged in the candidate. The pinned Node runtime, reporter, import guard and full selection are part of its definition. Each selected file must report successful tests; an exit-zero file wrapper cannot establish a pass. The guard rejects imports outside the evaluated copy, with exact exceptions for the trusted reporter and guard. It prevents accidental dependency resolution and provides no filesystem or network containment. Local project code runs with ordinary user permissions and a separate one-use check grant. No dependencies are installed or borrowed from the source checkout. Package-manager checks and arbitrary commands remain unsupported.

The fixed `crewkite-verify-v1` recipe supports source-configured CrewKite checkouts on macOS arm64 with an installed trusted verification policy. It runs policy, lint, types, the frozen Node collection, the desktop build and its journey. Its one-use `run-check` grant targets `crewkite verify` and authorizes local code with ordinary user permissions. Preparation freezes the manifests, lockfile, graders and process-enrollment helpers. Installed dependencies and Electron are inventoried and copied into the independent candidate; installed Node and Git are pinned and revalidated. HOME, temporary files, state and the Git index are separate. Missing tools or policy refuse without a package-manager, install or network fallback. This supplies no filesystem or network containment.

Staging, all six stages and cleanup share a ten-minute limit. The Node stage runs at most three test files at once. Admission requires eleven remaining original-run minutes and two attempts, preserving room for review. These check limits do not enlarge a writer or reviewer deadline. All six stage roots require an observed close with exit code 0 and no signal. Ordinary fixtures require observed process closure. The frozen scripted coder has one crash-time fallback: its bound Node exit-event receipt and positive group absence. That receipt records the Node callback. Every owned group must be absent before final source, toolchain and output integrity is recorded. Unknown ownership blocks passing evidence. Review and destination acceptance retain separate authority. Historical validation uses immutable proof identities; it never executes a saved executable or signals a saved PID. The existing Node recipes keep their definitions. Directory builds can carry a build-selected policy and exact frozen graders; the recipe still needs a matching registered source checkout with installed development dependencies and Electron. A supervised zero-model run completed all six real stages through normal candidate evaluation preparation and Start. Its candidate came from a scripted native protocol fixture. A read-only reopen preserved the completed proof and retained state. The [roadmap](roadmap.md) records the later useful packaged checked result and bounded D1b completion. Live OpenAI repository Stop and same-home reopen have separate evidence in the [provider notes](providers.md#repository-work). Full profile qualification remains pending; D2 and D3 retain their separate exits.

Newly resolved Quick quality requires declared checks and `keep-it-simple`. Standard adds `second-opinion`; Thorough adds `challenge-assumptions`, in that order. Second opinion requires the Reviewer role. Simplicity and assumption challenges permit Reviewer or Advisor. Same-route or same-family reviews establish process independence only. New Round-robin selection waits for an explicit ordered review panel; approved fallbacks do not authorize every backup to run. Stored runs retain their frozen methods and evidence bindings. Quick without a selected independent review labels that absence. These jobs inspect fixture patterns. They provide no model judgment or live provider qualification.

New review jobs bind the last stopped writer's attempt and route to its exact candidate receipt before dispatch. The same binding is checked when evidence is reused or accepted, including when two writers produce identical bytes. A different route does not establish model diversity. Older jobs without writer identity retain their original definition and show unknown provenance.

A handoff carries its task's candidate bytes, changes and retained evidence by immutable identity. Writer generations advance on writer transfers. Check and review jobs consume the same run's attempt and minute budgets without advancing writer generation. Explicit coding recovery captures current retained bytes into a fresh packet and labels unverified work.

A prepared draft can be edited only before its current run has attempts, allocation or unresolved work. Preparing again creates a new frozen run and keeps the old audit history. It does not start work or reuse approval.

A scratch grant allocates one workspace for one bounded run. Every successor still passes admission. Check and review dispatch freeze the candidate, evaluator and one-use authority. Stopping closes unresolved approvals. Resolving an export restores the task's prior state, including an already accepted publication.

Publication writes an immutable prepared pack before recording its effect. Acceptance imports the exact commit and candidate tree and verifies the original parent. D0 publication supports SHA-1 repositories. Export returns an immutable patch artifact; native save is a client action.

Accepting a candidate creates one new local branch in the source repository with create-if-absent semantics. Existing refs are never overwritten. After a crash, the controller reconciles the exact prepared ref before it reports `already-applied` or a conflict. A missing native publication ref requires the same frozen evidence and unchanged current source. An exact existing ref can reconcile its historical proof. Acceptance never merges, pushes or deploys.

Snapshots and frames are bounded. Replay beyond 1,000 events requires a fresh snapshot. A check or review interrupted during execution cannot be resumed as a new coder. Its retained work remains inspectable and exportable; preparing a new bounded run is explicit.

## Desktop security

Main loads bundled renderer assets through an allowlisted application protocol. The window uses sandboxing and context isolation, with no Node integration. Its CommonJS preload exposes payload-only callbacks and finite capabilities. Main validates the invoking window, main frame, exact page URL and shared payload schema for each request. Browser permissions, new windows, downloads and navigation are denied. Provider content renders as text.

One authenticated socket client in main serves the renderer. Main supplies command identity and keeps bounded replay while the page loads. Missing history remains visible after a snapshot repairs current state. Uncertain mutation receipts belong to the selected profile and retain their exact keys and content for explicit retry. Reconnection never resumes a run.

Project registration uses a parented native directory picker. Generic renderer commands cannot supply a registration path. Export remains a controller effect: main reads the returned immutable artifact, verifies its length and checksum, then offers a parented save dialog. A saved patch uses an unused destination and durable file and directory writes. Cancellation keeps the artifact available. The CLI receives the artifact result independently of desktop saving.

The packaged desktop defaults to the normal controller entrypoint. A fresh workspace has no synthetic project or scripted route catalog. The manifest selects one fixed workspace or demo entrypoint; page content and environment variables cannot change that mode. Initialized homes keep their retained state. The explicit demo has a separate bootstrap with a persisted fake catalog and a private home and profile. Main verifies the standalone Node version, platform, architecture and checksum before launch. The staged runtime resolves fixed entries inside its package. A connected source journey does not establish installed recovery.

## The person's MCP servers

The person's own MCP servers join a turn only when the controller writes them into that turn's config ([ADR 0046](adr/0046-the-persons-servers-join-a-thread-only-by-the-controllers-config.md)). Each server is off for every thread and gets one of three policies per thread: ask each time, allow reads or allow all. A policy never goes past the thread's permission policy. Under allow reads, only the listed read tools run without asking, and a server's own annotations can only narrow that list.

Each family has its own route. Anthropic gets the servers in one strict config and sends every call that is not on its allow list to the controller. Google takes them only while the thread asks for everything, so every call asks. OpenAI and Local run none. Review and advice turns are read-only and get none either. A turn that leaves a server out writes one line to its trace that says why.

Secret arguments and environment values are sealed with `safeStorage`, refused on a device with no keychain and never returned to the window. The controller removes each secret value from the turn's events and failure text. Only the desktop app supplies the servers.

The thread tools server is the one MCP source a turn gets without the person's choice. A turn without thread tools does not name them in its packet, and its adapter reads the request as no tools.

## Extensions

An extension is a folder under the CrewKite home with a manifest and an entry module ([ADR 0047](adr/0047-extensions-attach-through-one-versioned-seam.md)). It is off until the person turns it on, and turning it on names the hash of the folder the person was shown. The hash covers every regular file, so a later change turns the extension off again. The manifest's authority list is closed. Contract 1.0.0 offers `thread.read` and `thread.event`, and nothing else.

An extension command runs only through `RunExtensionCommand`, which passes the same owner, schema, receipt and task checks as a built-in command. The command gets a frozen context. Its reader and emitter work only on the thread the command ran on, and only while the command runs. Its output is text and label rows, validated before any event is emitted. Slots are data. Clients show their titles and the returned text and run no extension code. Crew roles are listed without being scheduled into the chain.

Contract 1.0.0 runs the module inside the controller process, so an enabled extension has the person's permissions. The seam limits what CrewKite hands it. It does not contain the code. [Extensions](extensions.md) is the reference for manifests and slots.

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

## Planned daily-work extensions

The current limits above describe shipped code, including whole-snapshot and source bounds. [Daily-work slices](daily-work-slices.md) records the implementation order; none of those planned capabilities is established by this section.

[Proposed ADR 0027](adr/0027-page-large-data-without-project-size-ceilings.md) keeps bounded transfer frames while paging views and streaming source, artifacts and integration. Aggregate project size should be limited by available resources and supported content, with explicit failures. A transport frame should not impose that product ceiling. Provider context assembly remains a separate, measured selection over retained local content.

[Proposed ADR 0028](adr/0028-journal-project-commands-and-remote-effects.md) places project commands and GitHub effects under the existing controller owner. Read-only status/log retrieval, local commands and remote publication keep distinct authority. The renderer retains its narrow bridge, and historical receipts cannot authorize replay of an uncertain command or remote effect.
