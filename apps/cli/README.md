# CLI

The CLI connects to the same controller as the desktop. It reads `CREWKITE_HOME`, defaults to `~/.crewkite`, and accepts `--home path` for isolated state.

```sh
pnpm crewkite task list --json
pnpm crewkite health --json
```

Register a Git checkout and create a draft task without opening the desktop:

```sh
pnpm crewkite project add /path/to/repository --json
pnpm crewkite task create <project-id> --title "Repair the total" --outcome "Return the correct total" --criterion "The discount cannot make the total negative" --criterion "Invalid inputs are rejected" --json
```

Use the project ID returned by registration. Repeating registration for the same checkout returns the existing project. Task creation requires a title, an outcome and at least one `--criterion`. It creates a draft with no run or provider work. Preparation and Start remain separate actions.

Task commands use IDs returned by the controller:

| Command | Behavior |
|---------|----------|
| `task show <task-id>` | Show the current task and snapshot cursor |
| `task watch <task-id>` | Stream events after a snapshot, with replay after reconnect |
| `task start <task-id>` | Start the prepared run |
| `task stop <task-id>` | Request stop using the current task revision |
| `task resume <task-id>` | Resume an interrupted run through controller admission |
| `task approve <approval-id>` | Approve the exact pending binding from the snapshot |
| `task deny <approval-id>` | Deny that binding |
| `task accept <task-id> <destination-ref>` | Request the checked candidate as a new local branch |
| `task changes <task-id>` | Read the retained candidate diff |
| `task export <task-id> --output new.patch` | Request export and save verified patch bytes to a new file |
| `task prepare-evaluation <task-id> <profile-id> --grants file [--recipe id] [--test-file path ...]` | Freeze separate check and reviewer authority for the current native candidate |
| `task start-checks <task-id>` | Start the saved local check once |
| `task start-review <task-id>` | Start the saved native review after matching checks pass |

Task show and watch snapshots include the current task's pending approvals and next action. Each approval carries its exact binding. Plain output lists approval and denial commands; neither runs automatically.

`--json` produces one JSON object for reads and actions. Watch emits one object per line, beginning with its task snapshot. A fresh snapshot replaces that state after a history gap. Ctrl+C stops watching.

Watch retains its cursor while the controller is offline. If the bounded reconnect window ends, it prints the next action and exits with status 1. Start the controller and run watch again to reconnect explicitly.

## Task conversations

A discussion starts from a goal. It needs no manually written acceptance criteria. Choose a primary planning role, the supported profile and finite task limits before consenting to a counted planning turn:

```sh
pnpm crewkite conversation create <project-id> --text "Repair the checkout total" --role lead --profile openai-file-v1 --credit-policy ordinary --attempts 8 --minutes 20 --concurrency 2 --consent --json
pnpm crewkite conversation show <task-id> --json
pnpm crewkite conversation send <task-id> --text "Explain the failure before proposing edits" --json
```

`lead` and `orchestrator` are distinct primary roles. The profile is currently limited to `openai-file-v1`; role availability still comes from controller admission. Limits require 1 to 100 attempts, 1 to 1440 minutes and 1 to 16 concurrent attempts. They cover planning and later execution together. Every selection is explicit, including `ordinary` or `existing-credits`. Creation can launch planning under that consent. Viewing history, reconnecting and reopening start no work. An unavailable role or profile remains unavailable.

| Command | Behavior |
|---------|----------|
| `conversation show <task-id> [--before-cursor cursor]` | Read authoritative state and one bounded history page |
| `conversation send <task-id> --text text` | Send a message under the saved planning consent, or queue it at the next safe boundary |
| `conversation answer <task-id> --question-id message-id --text text` | Answer one exact pending question |
| `conversation guide <task-id> --text text` | Queue guidance without changing the task contract or authority |
| `conversation adopt <task-id> --proposal-id message-id --proposal-hash hash` | Adopt the exact retained proposal after controller revalidation |
| `conversation configure <task-id> --role role --profile openai-file-v1 --credit-policy policy --attempts N --minutes N --concurrency N --consent` | Explicitly amend the finite primary selection and task limits |

Show returns `{ state, conversation }`. The state reports the primary selection, requested and effective model and effort, shared budget, queued input count, pending question IDs, proposal hash and current send/adopt availability. State and history are separate bounded controller reads. History entries retain their IDs, lineage and delivery records. `nextBeforeCursor` identifies the older page; pass it as `--before-cursor`. Text is limited to 4096 encoded bytes. Plain output escapes terminal controls; JSON preserves the typed values.

Mutations use the current task revision and the normal action receipt. Keep an uncertain receipt and use `retry` to resend its exact command. `task stop <task-id>` uses the existing Stop action. Chat text cannot approve a tool action, grant an effect, raise a limit or accept a candidate. Proposal adoption changes the task contract and starts no execution. Execution still needs its own explicit preparation and Start.

## Google quota

```sh
pnpm crewkite usage show --json
pnpm crewkite usage refresh --family google --consent --json
pnpm crewkite usage refresh --family google --json
pnpm crewkite usage refresh --family google --no-consent --json
```

`--consent` enables the reader and requests one read. Omitting consent requests a read under the saved opt-in. `--no-consent` disables the reader without a read and discards any in-flight result. Reads have a 60-second cooldown after each attempt, including failures. Active or unknown Google ownership blocks a read. No timer refreshes quota.

The reader uses the Google CLI's headless `/usage` command with no model request. Google's FAQ reserves headless mode for scripting and CI. Quota consent does not enable a writer. The [provider boundaries](../../docs/providers.md) describe this separate opt-in.

`usage show --json` returns `{ cursor, usageReaders, usage }`. Readers include enabled state, availability reason, last attempt and last successful observation. Usage contains the controller's derived windows with their source, observation time, reset time and stale state. Refresh returns the normal `{ command, result }` action receipt. Failed reads retain prior windows, which become stale after five minutes.

## Google ACP setup

Google’s published ACP agent, signed in with your own Google account. Google documents this agent for editors; CrewKite is not named.

Stage the official client and recorded identity as described in [provider routes](../../docs/providers.md). Import is a separate local action. It validates the managed copy and creates an immutable pin. It accepts no executable path, credential or replacement pin.

```sh
pnpm crewkite native import-google --consent --json
pnpm crewkite native setup show --family google --json
pnpm crewkite native setup initialize --family google --consent --json
pnpm crewkite native setup authenticate --family google --consent --json
pnpm crewkite native setup discover --family google --consent --json
pnpm crewkite native setup stop --family google --json
```

Each command performs only its named action. Initialization and discovery send no model prompt. Personal authentication can open a browser, contact Google and write native authentication state. CrewKite retains result codes and safe client proofs. Setup commands use the current persisted revision; Stop names the current operation. An uncertain command keeps its exact retry key. A fresh setup action does not replay it.

Setup status returns `{ cursor, setup, profile }`. Import returns `{ imported, reason, client }`, with version, digest and signer team only. Authentication and configuration do not establish entitlement or route qualification. Missing verified review mappings keep launch unavailable even when discovery exposes model choices.

When setup is ready, prepare a committed file using IDs advertised by discovery:

```sh
pnpm crewkite task prepare-native <task-id> google-acp-v1 net.mjs --policy native-policy.json --native-trust --source-consent --confirm-subscription-only --confirm-quota-account --model-id <observed-model-id> --thought-level-id <observed-thought-id> --json
```

Omit the thought-level flag when no selector was advertised. The preparation freezes its proof, model and optional thought level. Start reapplies and verifies those choices in a fresh session before prompting. Changed or unavailable options refuse; no fallback is selected. Saved consent can reuse only the matching preparation and attestations.

Google ACP permits guided or balanced authority, ordinary subscription billing and request-review. Each native approval requires a human decision for one exact session and tool call. Approval and denial preserve the full typed binding. Permanent permission and automatic handoff are unavailable.

`--confirm-quota-account` records that the separate CLI quota login and ACP sign-in use the same Google account. Shared native home does not prove identity. Every returned quota pool must be fresh and above reserve before admission. Disabling the reader grants no unknown-usage bypass. The headless Google file profile remains blocked.

## Local setup

Local uses one configured loopback endpoint and the same controller state as the desktop. Configure the endpoint, then request the native connection prompt:

```sh
pnpm crewkite local configure --endpoint ws://127.0.0.1:1234 --json
pnpm crewkite local connect --consent --json
pnpm crewkite local status --json
pnpm crewkite local refresh-models --consent --json
pnpm crewkite local select-model <selection-id> --observation-hash <observation-hash> --json
```

Enter the dedicated connection secret only in the native prompt. The CLI accepts no secret argument, stdin secret, credential environment option, setup receipt or helper path. Refresh reads the runtime's present models and loaded instances. It loads no model and starts no generation. Status reports the exact observation hash and selection IDs, with installed, loaded and incompatible states. Model identity comes from runtime metadata. It establishes no weight checksum or route qualification.

Each mutation uses the current Local revision. Selection requires the exact displayed observation hash and a choice from that observation. A stale revision or changed observation refuses. An uncertain receipt keeps its exact command key for `retry`; a fresh command does not replay it.

```sh
pnpm crewkite local cancel-input <operation-id> --json
pnpm crewkite local disconnect --json
```

Cancel names the current input operation. Disconnect clears the controller's private connection value and revokes pending input. Unknown input, discovery or generation ownership remains blocked. Neither command resets an uncertain generation. A controller without Local controls still exposes its retained snapshot and reports the controls unavailable.

After selecting an eligible loaded model, prepare one committed text target through the ordinary native path:

```sh
pnpm crewkite task prepare-native <task-id> local-file-v1 net.mjs --policy native-policy.json --native-trust --source-consent --json
pnpm crewkite task show <task-id> --json
pnpm crewkite task start <task-id> --json
pnpm crewkite task stop <task-id> --json
```

Preparation freezes the current selected model, setup, source and policy. It sends no provider request. Start rechecks controller admission and ownership. Local preparation accepts no cloud billing, effort, model override or handoff option. Changes and explicit export use the ordinary task commands. Repository writing, automatic handoff and Local review remain unavailable. Available model metadata still leaves qualification pending.

## Native single-file runs

Create the project and draft task through the commands above or the desktop. List the controller's supported native profiles:

```sh
pnpm crewkite native profiles --json
```

The snapshot reports profile availability, its reason, client version, model, effort and bounds. OpenAI and Anthropic have bounded local native paths. Google consumer automatic launch reports `provider-policy-restricted` and refuses before native discovery. The [dated provider boundaries](../../docs/providers.md#current-availability) explain these restrictions. Anthropic and Google report requested effort separately from unobserved effective effort and service tier. A missing qualification date is shown as pending. Preparation requires an available profile ID. Legacy profiles accept no executable, digest or model override. The ACP profile accepts only advertised configuration choices.

Save a policy JSON file using the existing policy schema. This example grants one scratch write and one export. Replace the sample task ID and project name with the registered values, and choose a future expiration before preparing the run:

```json
{
  "authority": "balanced",
  "quality": "quick",
  "methods": [{ "id": "keep-it-simple", "cycles": 1, "reviewerRole": "reviewer" }],
  "effects": [
    {
      "action": "write-scratch",
      "target": "crewkite",
      "taskId": "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "expiresAt": "2026-10-18T00:00:00.000Z",
      "revoked": false,
      "usesRemaining": 1
    },
    {
      "action": "export-patch",
      "target": "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "taskId": "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "expiresAt": "2026-10-18T00:00:00.000Z",
      "revoked": false,
      "usesRemaining": 1
    }
  ],
  "limits": { "attempts": 4, "minutes": 5, "concurrency": 1 },
  "reserves": [],
  "unknownUsage": { "rule": "fixed-allowance", "allowance": { "launches": 1, "minutes": 5 } }
}
```

Prepare one existing committed text file with explicit native trust and source consent:

```sh
pnpm crewkite task prepare-native <task-id> <profile-id> docs/providers.md --policy native-policy.json --native-trust --source-consent --json
pnpm crewkite task show <task-id> --json
pnpm crewkite task start <task-id> --json
```

For an Anthropic writer, add `--confirm-subscription-only` to confirm both that the existing native login uses your subscription and that paid extra usage is disabled. This flag records your attestation. It does not change account settings or establish provider permission, included billing or a hard spending cap. OpenAI preparation rejects this flag. Anthropic supports ordinary usage only.

Prior Google pilot preparations also recorded this attestation and an explicit `--permission-mode`. Saved Google runs remain readable; these options do not enable the unavailable consumer profile.

Task show includes the matching native run and source, frozen target path, base hash, byte count, consent expiry and stage. Saved billing confirmations appear with their user-attested provenance. Google also shows its expected native permission mode. Older retained runs can report unknown target facts or expiry.

Preparation spends no inference. Start rechecks controller admission and launches the saved run. Without both consent flags, preparation requests the controller's exact saved consent. A single flag is rejected. Changed source, target, criteria, policy, profile or billing choice can invalidate that consent. Anthropic and Google require billing confirmations even with saved consent. Omitting the confirmation flag can reuse only the matching current native run's saved attestation; missing confirmations are never inferred.

Existing-credit spending defaults off. Add `--existing-credits` only when choosing that policy explicitly. Available included usage does not establish a provider-enforced hard billing cap. Native trust and billing limits are described in [provider routes](../../docs/providers.md).

The native path retains a single-file candidate. Stop waits for owned cleanup. Resume cannot submit another native writer turn for retained work. Checks and review require separate preparation and explicit starts. Manual file transfer requires recipients allowed during initial preparation and fresh consent after confirmed Stop. Local acceptance requires matching completed checks and review, plus its own destination permission.

```sh
pnpm crewkite task changes <task-id>
pnpm crewkite task export <task-id> --output candidate.patch --json
```

A saved patch can be carried to a provider's native app manually. CrewKite does not open that app or import its result automatically.

Export reads bounded artifact pages and verifies identity, offsets, length and checksum before creating the destination. Existing files are never overwritten. Plain diff output escapes terminal control characters. If export needs approval, its receipt includes the next approval command. Approve that export with `task approve <approval-id> --output new.patch`, or retry the saved export approval receipt with `--output new.patch` after inspecting its result.

## Manual native file transfers

This path currently has offline fixture coverage only. Connected manual transfer remains unqualified, and each recipient still needs its own supported authentication and provider permission. Google consumer CLI launch is unavailable and cannot serve as a transfer recipient.

New file runs can opt into a finite recipient list. Add `--handoff-target` for each allowed file profile during `prepare-native`. Repository work and older runs do not support this option. Targets default to ordinary usage; only `openai-file-v1:existing-credits` opts that recipient into existing credits. The writer's credit choice does not authorize recipient spending.

```sh
pnpm crewkite task prepare-native <task-id> openai-file-v1 net.mjs --policy native-policy.json --native-trust --source-consent --handoff-target anthropic-file-v1 --handoff-target openai-file-v1 --json
```

Choose the original limits before preparing. A Quick run with two writers, one check and one review needs at least four overall attempts and two launches per route. Launch allowance is per route; the overall attempt limit still applies. Every writer spends the same original minutes. The desktop offers an explicit two-writer choice of four attempts, twelve minutes and two launches per route. It starts nothing. Two reserved minutes cover the standard check/review path; full verification requires six remaining minutes. Later transfer cannot raise or replenish limits.

After normal Stop and confirmed process cleanup, inspect retained Changes. Prepare one previously allowed recipient with fresh trust and source-sharing consent:

```sh
pnpm crewkite task prepare-handoff <task-id> anthropic-file-v1 --native-trust --source-consent --confirm-subscription-only --json
pnpm crewkite task show <task-id> --json
pnpm crewkite task start-handoff <task-id> --json
```

OpenAI rejects subscription confirmation and permission-mode flags. Saved Google pilot settings remain readable, but do not authorize a new consumer launch. Add `--existing-credits` only when selecting that exact previously saved OpenAI recipient policy. No outgoing billing confirmation or native setting is inherited.

Preparation freezes the retained unverified file and task packet. It launches nothing and takes no new policy or grants file. Start binds the displayed pending preparation and starts a fresh writer, with no native-session resume. Each successor requires explicit authorization for its saved recipient and preparation. The original pin and role assignments remain unchanged. The controller rechecks source, ownership, recipient and remaining allowance. Files must fit every selected profile's 64 KiB bound. Earlier evidence remains history; changed work needs new checks and review.

Task show reports allowed recipients, current generation, pending recipient, expiry and preparation/start reasons. Reopening submits nothing. Stop cancels an unstarted transfer. If an outcome is uncertain, inspect the task and retry its exact saved receipt; no automatic retry or fallback occurs. Selecting a recipient establishes no provider entitlement or permission to use a subscription through another application. The [provider boundaries](../../docs/providers.md) retain their separate qualification limits.

## Native repository work

Repository work uses the `openai-repository-v1` profile and the committed repository. It accepts no target path or execution override:

```sh
pnpm crewkite task prepare-repository <task-id> openai-repository-v1 --policy repository-policy.json --native-trust --source-consent --json
pnpm crewkite task show <task-id> --json
pnpm crewkite task start <task-id> --json
```

The policy must include an unexpired one-use `run-native-tools` grant for the task and project name, alongside `write-scratch`. Add that grant explicitly to the policy above. Preparation never inserts it. The grant is consumed once at launch and permits multiple local commands during the bounded task. Omitting both consent flags requests exact saved repository consent. File consent cannot authorize local commands. Existing credits stay off unless `--existing-credits` is supplied.

The native client can edit independent scratch and run local commands. Its fixed settings are `workspace-write`, approval `never` and network access off. Requests needing native approval are refused. These settings do not establish separate filesystem or process containment by CrewKite. No account or native settings are changed.

Task show reports the frozen committed base, manifest hash, file and byte counts, execution settings and expiry. Inspect retained changes and export through the same commands as file proposals. A native command's exit status or summary establishes no check evidence. Resume and handoff remain unavailable.

## Candidate checks and review

The default `node-tests-v1` recipe covers the synthetic `net.mjs` project. The `project-node-tests-v1` recipe uses 1 to 32 explicit committed Node test files. The saved run must select one `keep-it-simple` review cycle and retain enough of its original budget for a local check and a separate native review. Preparation does not lower the saved quality floor.

Save a JSON array containing exactly two one-use grants. Replace the task ID and choose a future expiration:

```json
[
  {
    "action": "run-check",
    "target": "node --test",
    "taskId": "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "expiresAt": "2026-10-18T00:00:00.000Z",
    "revoked": false,
    "usesRemaining": 1
  },
  {
    "action": "run-review",
    "target": "keep-it-simple/cycle-1",
    "taskId": "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "expiresAt": "2026-10-18T00:00:00.000Z",
    "revoked": false,
    "usesRemaining": 1
  }
]
```

Select a supported OpenAI reviewer independently of the writer. Prepare consent for sending the original file, candidate and task text to a fresh reviewer process:

```sh
pnpm crewkite task prepare-evaluation <task-id> <profile-id> --grants evaluation-grants.json --native-trust --source-consent --json
pnpm crewkite task show <task-id> --json
pnpm crewkite task start-checks <task-id> --json
pnpm crewkite task show <task-id> --json
pnpm crewkite task start-review <task-id> --json
```

For project tests, add the recipe and repeat `--test-file` for each exact relative path:

```sh
pnpm crewkite task prepare-evaluation <task-id> <profile-id> --grants evaluation-grants.json --recipe project-node-tests-v1 --test-file test/pricing.test.mjs --test-file test/tax.test.mjs --native-trust --source-consent --json
```

For a source-configured CrewKite checkout on macOS arm64 with an installed verification policy, `crewkite-verify-v1` runs the fixed policy, lint, types, Node tests, desktop build and desktop journey stages. It copies installed dependencies and Electron, and verifies local Node and Git. Set the `run-check` grant target to `crewkite verify`, keeping the separate reviewer grant:

```sh
pnpm crewkite task prepare-evaluation <task-id> <profile-id> --grants verification-grants.json --recipe crewkite-verify-v1 --native-trust --source-consent --json
```

Before starting the source controller, set `PROVENANCE_PATTERN` in its environment to the installation's provenance regular expression used by `scripts/policy.mjs`. If that value is empty, the controller reads `internal/provenance-pattern.txt` under its source checkout. Setting the variable only for a CLI command does not configure an already running controller. A missing policy blocks preparation with `verification-policy-unavailable`. Wait for all active work and preparation to stop, then restart the source controller with the policy configured and prepare the evaluation again.

The Mac directory-package builder selects `PROVENANCE_PATTERN` from its build environment or `internal/provenance-pattern.txt` under the primary checkout. A selected policy must be a nonempty valid expression within the recipe's limit. It carries that policy and exact frozen graders into the installed runtime. A build without either policy source remains available for ordinary use and cannot prepare this recipe. Packaged checks still require a registered matching CrewKite checkout with its development dependencies and Electron already installed. The package supplies Node; system Git and mkfifo remain required. The builder installs no dependencies and changes no account settings. The [roadmap](../../docs/roadmap.md) records the first useful packaged checked result and remaining qualification gates.

This recipe takes no test-file or command options. Staging, all stages and cleanup share at most five minutes. The original run needs at least six remaining minutes and two attempts, including the later review. The controller freezes toolchain and baseline identities before Start. Task show reports the fixed stages, platform, Node, Electron and Git versions and digests, lockfile and toolchain hashes. No dependencies are installed. Local code runs with your system permissions; no added filesystem or network containment is established.

Project Node tests run local code with your system permissions. Dependencies are not installed. Imports can use Node built-ins and files in the check copy. Paths are literal, with no globs or discovery; names with spaces need shell quotes. The controller freezes the committed files and refuses changed definitions before execution. Inspect `task show` before starting checks.

Preparation starts no checks or native review. Verification preparation first inventories the installed files. Omitting both consent flags requests exact saved evaluation consent. Reviewer credit spending defaults off independently of the writer. Add `--existing-credits` during evaluation preparation only when choosing that policy explicitly.

Task show reports the controller's evaluation stage, selected recipe and test files, exact file and hashes, saved reviewer and process-only independence, expiry, current start availability and remaining total attempts and minutes. The supplemental allowance permits one local check and one additional native review beneath those original run limits. Completed evidence remains visible after start permission expires. A failed or blocked check cannot authorize review. Task show also reports current local acceptance availability and its reason. Completed checks and review can make acceptance available. The destination still needs its own current grant or approval; inspection and export remain available.

## Combined tasks

Prepare a parent and two existing draft tasks from the same project. Save the complete `PrepareCombinedRun` payload in a bounded JSON file. The CLI validates the shared schema before connecting. It preserves the child revisions you supplied and uses the current parent revision. This example names two existing text targets and three committed check files:

```json
{
  "taskId": "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "policy": {
    "authority": "balanced",
    "quality": "quick",
    "methods": [{ "id": "keep-it-simple", "cycles": 1, "reviewerRole": "reviewer" }],
    "effects": [
      { "taskId": "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAW", "action": "write-scratch", "target": "demo-shop", "expiresAt": "2026-10-18T00:00:00.000Z", "revoked": false, "usesRemaining": 1 },
      { "taskId": "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAX", "action": "write-scratch", "target": "demo-shop", "expiresAt": "2026-10-18T00:00:00.000Z", "revoked": false, "usesRemaining": 1 }
    ],
    "limits": { "attempts": 7, "minutes": 20, "concurrency": 2 },
    "reserves": [],
    "unknownUsage": { "rule": "fixed-allowance", "allowance": { "launches": 2, "minutes": 20 } }
  },
  "children": [
    { "taskId": "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAW", "expectedRevision": 0, "scope": ["price.mjs"], "writer": { "profileId": "openai-file-v1", "creditPolicy": "ordinary" }, "consent": "explicit", "maximumMinutes": 2 },
    { "taskId": "tsk_01ARZ3NDEKTSV4RRFFQ69G5FAX", "expectedRevision": 0, "scope": ["invoice.mjs"], "writer": { "profileId": "openai-file-v1", "creditPolicy": "ordinary" }, "consent": "explicit", "maximumMinutes": 2 }
  ],
  "checks": {
    "recipeId": "project-node-tests-v1",
    "testFiles": ["price.test.mjs", "invoice.test.mjs", "interaction.test.mjs"],
    "replayTestFiles": [["price.test.mjs"], ["invoice.test.mjs"]],
    "interactionTestFiles": ["interaction.test.mjs"],
    "maximumMinutes": 1,
    "baselineConsent": "explicit",
    "replayConsents": ["explicit", "explicit"]
  },
  "reviewer": { "profileId": "openai-file-v1", "creditPolicy": "ordinary", "maximumMinutes": 2 }
}
```

Replace the IDs, child revisions, project name, paths and grant expiry with current values. Both targets must be distinct existing committed text files outside the protected checks. The full test collection must contain both replay collections and the separate interaction tests. Paths are literal. The controller freezes the common source and validates every selected check. The CLI adds no grants or consent. Other finite writer selections retain their own billing attestations and observed configuration requirements; unavailable profiles remain unavailable.

```sh
pnpm crewkite combined prepare <parent-task-id> --plan combined-plan.json --json
pnpm crewkite combined status <parent-task-id> --json
pnpm crewkite task start <parent-task-id> --json
```

Preparation starts no work. Parent Start runs the baseline. After it passes, start each child with `task start <child-task-id>`. Status reads the current group from the snapshot: exact preparation, member runs and scopes, seven dispatch slots, candidate, shared remaining budget and controller action reasons. All work shares the parent allowance. Parent `task stop` stops the group; a child Stop does not complete it.

```sh
pnpm crewkite combined assemble <parent-task-id> --json
pnpm crewkite combined status <parent-task-id> --json
```

Assembly binds the saved parent run and preparation. It takes no patches, candidate list, Git ref or command. The controller checks the serial replays before advancing its private integration ref. Final combined checks and independent review remain separate existing evaluation actions. Only the parent can be accepted after the complete barrier passes. Preserve uncertain prepare or assembly receipts and use `retry` with the original command. Reopening status starts nothing. These commands establish no connected provider or combined-work qualification.

## Local branch acceptance

Inspect Changes and the retained evidence before requesting a branch:

```sh
pnpm crewkite task show <task-id> --json
pnpm crewkite task accept <task-id> refs/heads/feat/checked-result --json
```

The controller revalidates the candidate, original source and exact successful checks and review. It uses a current acceptance grant for that destination or returns a pending local approval with a `nextCommand`. Review the destination in the receipt, then approve once:

```sh
pnpm crewkite task approve <approval-id> --json
```

Acceptance creates one local branch without checking it out. It preserves the original checkout and index. Existing refs are never overwritten, and nothing is merged or pushed. Expired inference consent or an unavailable provider does not erase completed evidence. Source changes or incomplete ownership proof can still block publication. Keep an uncertain action receipt and retry its exact saved command after inspection.

## Uncertain actions

Action JSON contains `command` and `result`. Keep that receipt when the result is `outcome-unknown`. The saved command includes the original key, revision and approval binding. Inspect current state before choosing a retry:

```sh
pnpm crewkite retry receipt.json --json
```

Retry validates the bounded receipt file and resends its command unchanged. It never builds a new approval or refreshes an old grant. For an applied export receipt, `retry receipt.json --output new.patch` saves the same verified artifact without creating another export command. A failed local save still prints the original action receipt. Both interfaces use the controller's policy and permission rules.

Exit status is 0 for an applied action or a successful read, 2 for a controller refusal or uncertain result, and 1 for local input or connection errors. JSON preserves typed provider output. Plain output escapes terminal controls. Plain watch output contains event identities and revisions.
