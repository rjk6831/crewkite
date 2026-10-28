# CLI

`crewkite` is the terminal client of CrewKite. It connects to the same controller as the desktop, over the same socket and with the same commands, so a thread started in one shows in the other. It reads `CREWKITE_HOME`, defaults to `~/.crewkite`, and accepts `--home path` for isolated state. The controller has to be running: the desktop starts one, and `pnpm controller` starts one on its own.

Run with no subcommand on a terminal, it opens the interactive mode. With a subcommand, or when stdout is not a terminal, it runs that command and exits.

```sh
pnpm crewkite                                   # interactive mode
pnpm crewkite -p "Why can the total go negative?"   # one reply to stdout
pnpm crewkite thread list --json                # scripting
```

The CLI adds no authority. Every action it offers is a command the controller checks the same way it checks the desktop's: a permission answer must name an open request and an option it offered, Accept builds one new local branch, and Push needs your confirmation. No setting grants a permission, raises a limit or accepts a result: a thread's permission policy changes only when you name it for that thread, with a flag for one run or by answering the question in the interactive mode.

A recorded session is in [docs/images/cli-session.txt](../../docs/images/cli-session.txt).

## Interactive mode

The screen opens with the kite wordmark, in block letters at 72 columns and wider and in two rows below that. Under it sit the thread, the message box, the model the next message goes to and one gauge per provider.

A new thread goes to the registered project of the checkout you started in. The CLI takes that directory from `INIT_CWD` when pnpm set it, else the current directory, and a project matches when its folder name, HEAD commit and branch are the checkout's. When none or several match, the first send opens the thread list and asks which project to use.

A reply streams into the thread as it arrives. Markdown renders as terminal text: headings, lists, quotes, tables and fenced code. Thinking shows as a card with its latest line; Alt+T shows all of it. Tool calls show as cards, and a run of finished reads and searches folds into one line such as "Read 14 files", the way the desktop folds them. While a reply runs, the kite spinner turns beside the model name.

A permission request appears inline with the options the provider offered, numbered: allow once, allow for this thread and deny. Press Tab to give the request focus, then the number. While the message box has focus, a digit is text. Tab or Escape gives the focus back. The prompt names the thread's permission policy, which you change on the crew screen. A message you send while a reply runs waits in the queue; Alt+S sends the first one now and Alt+X takes it back.

A failed turn shows its cause, the provider's own message and the next step, with Alt+R to retry and Alt+1 to Alt+4 to try it with another connected family, in the order the desktop's Try with uses. Alt+G regenerates the last reply.

| Key | Action |
|-----|--------|
| Enter | Send, or take the highlighted completion |
| Alt+Enter, Shift+Enter, or a line ending in `\` | New line |
| Up, Down | Move between lines; on the first or last line, walk the history of sent messages |
| Tab | Take the highlighted completion |
| Escape | Stop the running reply, close a list or go back to the thread |
| Ctrl+T | Threads, and the project a new thread goes to |
| Ctrl+G | Changes |
| Ctrl+O | Settings |
| Ctrl+K | Keys and slash commands |
| Ctrl+C | Leave; while a reply runs it asks first, and the reply keeps running in the controller |

### Slash commands and mentions

Type `/` for the list. `/new`, `/model [model[:effort]]`, `/provider family`, `/crew`, `/plan`, `/ask question`, `/handoff family`, `/changes`, `/accept [branch]`, `/push`, `/pr`, `/settings`, `/help` and `/prompt name` do what the same entries do in the desktop. `/ask` sends a read-only question to the best ranked family other than the thread's own. `/prompt` needs the saved prompts the controller adds with the composer update and says so until then.

`@` followed by part of a path offers the project's files and folders, ranked by the shared mention rules, and inserts the path. A path that starts with `/` or `~/`, such as `@~/Desktop/shot.png`, attaches that file from disk: the controller copies it into the thread's files and sends it the way each provider takes it.

### Changes, Accept, Push and pull requests

Ctrl+G opens Changes: the changed files with their line counts and the diff of the selected file. A accepts the scratch copy on a new local branch, with a name you can edit. P pushes the accepted branch after you answer the question that names the branch, the remote and that your own git credentials are used. O opens a pull request through gh, or gives the compare link without it. While the branch is pushed, the CI runs for it refresh every thirty seconds. D discards one file's changes after asking.

### Crew, plan and handoff

`/crew` shows the crew, the flight mode, the permission policy and the handoff mode. 1, 2 and 3 apply the Solo, Pair and Full crew presets; F, P and H cycle the flight mode, permission policy and handoff mode; A turns automatic handoff on or off. `/plan` shows the orchestrator's plan card with each slice's state and assignment. R runs the plan, C cancels it, S stops it, and a slice number runs that slice once its dependencies are done.

### Settings and appearance

Ctrl+O opens Settings: theme, animation, the model new threads start on, the handoff mode new threads get and the permission policy to offer them, followed by one card per provider with its connection, its gauge and its models. C checks the Anthropic sign-in or reads the Google or OpenAI quota for the provider of the default model you picked, and does nothing until you pick one.

Gauges use the desktop's colour rule: green with plenty left, yellow at 40 percent and red when empty. A reading older than 60 minutes draws dotted. Provider marks are O, A, G and L in the kite panel colours. `NO_COLOR` turns every colour off and keeps the shapes. `--no-animation`, or `"animation": "reduced"` or `"off"` in the settings file, keeps the spinner still; the desktop follows the system's reduced motion setting, which a terminal does not expose, so the CLI takes it from the settings file.

### Settings file

The CLI keeps its own settings in `cli.json` in the CrewKite home. Settings writes it for you; a file you edit by hand is checked with `CliSettingsSchema`, which reuses the schemas the desktop saves its thread defaults with. A value the schema refuses leaves the defaults in force, and the CLI says which field. While it does, Settings saves nothing, so the file stays as you wrote it until you fix it.

A setting never grants a permission. Every new thread starts on ask each time. When `permissionPolicy` names another policy, the interactive mode asks after the first message whether to switch that thread to it; print mode and `thread new` ignore it and take `--permission-policy` for the one run.

```json
{
  "theme": "system",
  "animation": "full",
  "keybindings": { "threads": ["ctrl+t"], "newline": ["alt+enter", "shift+enter"] },
  "selection": { "family": "openai", "model": "<model-id>", "effort": "default" },
  "permissionPolicy": "ask",
  "handoffMode": "most-left",
  "familyModels": {},
  "crewPresets": {}
}
```

Key bindings exist for send, newline, stop, threads, changes, settings and help. A binding is a list of keys such as `ctrl+t` or `alt+enter`. `system` follows `COLORFGBG` when the terminal sets it and assumes a dark background otherwise.

### Packaged builds

The package carries the interactive mode. [scripts/cli-runtime.ts](../../scripts/cli-runtime.ts) copies Ink, React and their pinned closure into a private store under `apps/cli`, laid out so that the two ansi-styles versions in that closure each reach only the packages that asked for them, and copies the renderer modules the views import. The package build itself runs on macOS arm64.

## Thread commands and print mode

```sh
pnpm crewkite thread new <project-id> "Clamp the discount" [--permission-policy policy] --watch
pnpm crewkite thread send <task-id> "Add a test" --model openai --watch --json
pnpm crewkite thread watch <task-id> [--follow]
pnpm crewkite thread permit <task-id> <request-id> [--thread]
pnpm crewkite thread deny <task-id> <request-id>
pnpm crewkite thread stop <task-id>
pnpm crewkite thread accept <task-id> <branch> [--message text]
pnpm crewkite thread push <task-id> [--remote origin] --confirm
pnpm crewkite thread pr <task-id> [--title text] [--body text]
pnpm crewkite thread list
pnpm crewkite thread show <task-id>
pnpm crewkite -p "message" [--thread task-id | --project project-id | --register] [--model family[/model[:effort]]] [--permission-policy policy] [--file path ...]
```

`--model` takes a family, which runs its default model, a family and model, or a family, model and effort. Without it the CLI uses the `selection` from `cli.json`, then the connected family with the most allowance left. `--file` attaches a file from disk.

`permit` answers with allow once, or with allow for this thread when you add `--thread`. `push` without `--confirm` prints what it would push and sends nothing.

Print mode sends one message and streams the reply to stdout; tool lines, permission requests and failures go to stderr. Without `--thread` it starts a new thread in the registered project of the Git checkout you ran it in, found the way the interactive mode finds it, with every `GIT_` variable left out. It registers nothing on its own: a checkout the controller does not hold needs `--project`, or `--register` to register it, and the refusal names both. `-p` counts only before the first positional argument.

`--permission-policy ask`, `allow-edits` or `allow-all` sets the new thread's policy for this run, and print mode prints the policy in use to stderr. A permission request waits for an answer from `thread permit` or `thread deny` in another terminal, the interactive mode or the desktop. If the connection to the controller ends and does not come back, print mode and `thread watch` say so and exit 1; the turn may still run in the controller. After a gap in the stream they read the thread again. `thread watch --follow` prints each later turn as its record arrives.

### Exit status

Every command, the task commands included, uses one table.

| Status | Meaning |
|--------|---------|
| 0 | The request applied, or the followed turn finished |
| 1 | It failed: an error, a failed read, a lost connection, an incomplete list, a followed turn that failed, or a value a task command rejects after reading its arguments |
| 2 | Nothing was done: arguments that do not parse, arguments a thread command or print mode rejects, or a request the controller refused, with its reason printed |
| 3 | The followed turn was stopped |

With `--json` every line is one object that `CliJsonLineSchema` in `packages/contracts/src/cli.ts` accepts. `kind` says which: `event` for a thread event (agent events, turn and thread records, stored messages), `result` for the controller's answer to a command with its reason and next step, `turn-end` with the status of the followed turn, `thread` for a thread read, `threads` for the list and `error`. Every line carries `v: 2`. That number names one fixed shape, the embedded thread, turn, message and event shapes included: the CLI's schema test pins a hash of the whole shape, so a change to any of them moves `v`.

## Task commands

These commands predate the chat thread and keep working as they did. They take `--home path` like every other command.

```sh
pnpm crewkite task list
pnpm crewkite task list --pages --json
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
| `task amend <task-id> --title text --outcome text --criterion text [--criterion text ...]` | Replace the full contract using the current task revision, preserving the task ID |
| `task pause <task-id>` | Close admissions for the exact current run; owned work may finish |
| `task start <task-id>` | Start the prepared run |
| `task stop <task-id>` | Request stop using the current task revision |
| `task resume <task-id>` | Explicitly request Resume through controller admission; native restart is unavailable |
| `task approve <approval-id>` | Approve the exact pending binding from the snapshot |
| `task deny <approval-id>` | Deny that binding |
| `task accept <task-id> <destination-ref>` | Request the checked candidate as a new local branch |
| `task changes <task-id>` | Read the retained candidate diff |
| `task export <task-id> --output new.patch` | Request export and save verified patch bytes to a new file |
| `task prepare-evaluation <task-id> <profile-id> --grants file [--recipe id] [--test-file path ...]` | Freeze separate check and reviewer authority for the current native candidate |
| `task start-checks <task-id>` | Start the saved local check once |
| `task start-review <task-id>` | Start the saved native review after matching checks pass |

Task show and watch snapshots include the current task's pending approvals and next action. Each approval carries its exact binding. Plain output lists approval and denial commands; neither runs automatically.

`task list` streams summary rows through bounded pages until the complete list has been read. A failed page leaves the received rows visible and exits with status 1, reporting an incomplete list. Status and setup commands read workspace metadata without loading task history.

`task list --pages --json` emits one versioned task-page object per line. Each object includes its workspace stamp, cursor, summaries, continuation and completeness. Pages contain at most 100 rows and 512 KiB; the default is 50 rows. Only the final page has `complete: true` and `next: null`. Keep pages from one traversal together. A changed workspace can invalidate the continuation; rerun the command to start a new traversal.

`task list --json` retains the legacy `{ cursor, tasks }` object with full task records. It uses the existing global snapshot and its frame limit; large workspaces can exceed that limit.

`task activity <task-id> [--before-cursor cursor]` emits bounded activity page objects until the beginning of retained history. Large bodies appear as `event-body` references with their original event identity and an artifact. No event is omitted to fit a page. A failed read exits with an error; retry the last requested cursor.

Use `artifact read <artifact-id>` for sequential text display, or add `--json` for base64 range objects followed by a complete checksum proof. Each range is explicitly unverified. A checksum failure leaves received ranges visible and exits with an error. `artifact verify <artifact-id>` checks the complete content without displaying it. `artifact save <artifact-id> --output new-file` stages the content and creates the destination only after exact length and SHA256 verification. Existing destinations are preserved. These commands use bounded range requests and accept retained content above 64 MiB.

Other `--json` reads and actions produce one JSON object. Watch emits one object per line, beginning with its task snapshot. A fresh snapshot replaces that state after a history gap. Ctrl+C stops watching.

Watch retains its cursor while the controller is offline. If the bounded reconnect window ends, it prints the next action and exits with status 1. Start the controller and run watch again to reconnect explicitly.

### Task conversations

`conversation show <task-id> [--before-cursor cursor]` reads a task's retained conversation state and one bounded history page. New messages go through the chat thread, in the desktop app, the interactive mode or the thread commands.

### Saved task lifecycle

Amend requires the complete explicit title, outcome and criteria on every call. Omitted fields are rejected. The controller permits amendment only in `draft`, `stopped`, `interrupted` or `failed`, with proven quiescence and no conflicting ownership or combined membership. It keeps the task ID, advances its revision and clears the current run binding. Inspect the result, then prepare explicitly when ready. Amendment starts no work and grants no authority.

Pause sends `PauseAdmissions` with the current task revision and exact current run ID. An unprepared task has no run to pause. Pause closes new admissions; an already owned process may finish. Stop requests cancellation of owned work. Neither command creates a grant or submits new work. Resume remains an explicit controller request. It does not provide a general native restart path, and reopening a task never relaunches work.

A combined parent Pause records its current phase. Child Pause and Resume refuse while the parent owns the membership, and a child cannot amend its contract independently. Parent Resume requires settled owners, valid proofs and enough remaining budget. Unknown ownership or failed or stopped stages block it. Combined Resume dispatches nothing and cannot restart a child writer. Parent Stop requests cancellation across the group. See [combined ownership and recovery](../../docs/continuity.md#combined-ownership-and-recovery).

Blocked and unknown outcomes remain visible in the action receipt. Save JSON output when a result is uncertain and use `retry <receipt-file>` only for that exact receipt. Retry retains the original command key, payload and expected revision, including the full amendment contract or exact paused run binding. It does not refresh the revision or reread contract flags. No automatic retry, preparation or follow-up action runs after amend or pause.

### Provider quota

```sh
pnpm crewkite usage show --json
pnpm crewkite usage refresh --family google --json
pnpm crewkite usage refresh --family openai --json
```

The quota reader runs by default when the pinned client is available. Controller startup attempts one read. Authenticated connections can refresh missing, stale or unknown observations, and Google admission can make one needed bounded read. Reads have a 60-second cooldown after each attempt, including failures. Active or unknown Google ownership blocks a read. A fresh reported zero remains fresh and does not cause another read just for being zero.

OpenAI refresh uses the existing pinned native account metadata reader. It sends no model turn. Its status includes the ownership state, bounded result reason and last protocol request, so a timed-out read remains visible without guessing an authentication failure. Anthropic refresh invokes the pinned native local `/usage` command and sends no generation request. The first refresh needs explicit native-client trust for the exact scope shown by `usage show`. Native user or administrator policy hooks are covered by that trust. I retain consent only for the same client, command and reader policy.

```sh
pnpm crewkite usage show --json
pnpm crewkite usage refresh --family anthropic --native-trust --usage-scope <scope-hash> --json
pnpm crewkite usage refresh --family anthropic --json
pnpm crewkite usage stop <operation-id> --family anthropic --json
```

Later refreshes reuse matching trust. Stop joins the existing operation. Anthropic has its own sixty-second cooldown after every attempted read, including failures; active or unknown Anthropic task, sign-in or usage ownership blocks another read. The report keeps native window rows and extra-usage metadata separately. Receipt time is visible while observation time and cache age remain unknown. A failed refresh retains the previous report and its provenance. This report grants no coding authority, included billing or task qualification. Offline fixtures verify this path; no new live subscription qualification is claimed.

The reader calls the pinned Google CLI's headless `/usage` metadata command without a model request. A quota read supplies no coding authority, account identity, provider entitlement or billing hard cap. The [provider boundaries](../../docs/providers.md) describe this status check and its limits.

`usage show --json` returns `{ cursor, usageReaders, usage }`. Readers report availability and its reason, the last attempt and the last successful observation. Derived usage windows retain their source, observation and reset times, and stale state. Refresh returns the normal `{ command, result }` action receipt. Failed reads retain prior observations and their original timestamps; they become stale after five minutes. Keep an uncertain refresh receipt and use `retry <receipt-file>` for that exact saved command key.

Admission rechecks every bucket applicable to the frozen selected model and every configured reserve. A known separate model pool does not consume that selection's allowance. Required selected-model windows must be present; third-party and unknown buckets retain conservative checks. Missing client or invalid output cannot become known allowance. The provider-boundaries link above records the exact mapping.

### Google ACP setup

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

`--confirm-quota-account` records that the separate CLI quota login and ACP sign-in use the same Google account. Shared native home does not prove identity. Admission rechecks every applicable quota pool and configured reserve for the frozen selected model; required windows must be present, and unknown pools remain conservative. Missing, stale or unknown quota must be resolved before admission. The headless Google file profile remains blocked.

### Local setup

Local uses one configured loopback endpoint and the same controller state as the desktop. Dedicated token is the default authentication mode. Configure the endpoint, then request the native connection prompt:

```sh
pnpm crewkite local configure --endpoint ws://127.0.0.1:1234 --json
pnpm crewkite local connect --consent --json
pnpm crewkite local status --json
pnpm crewkite local refresh-models --consent --json
pnpm crewkite local select-model <selection-id> --observation-hash <observation-hash> --json
```

For a runtime already configured without authentication, choose that mode explicitly:

```sh
pnpm crewkite local configure --endpoint ws://127.0.0.1:1234 --authentication none --json
pnpm crewkite local connect --consent --json
```

The desktop reports this mode as "No authentication, this device only". Connect uses the saved mode and opens no token prompt in this mode. CrewKite does not change the runtime's authentication setting. `--authentication token` restores the dedicated-token mode; omitting the option on configure also selects token mode. Status reports authentication separately from connection state. A no-auth connection has no configured secret.

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

### Native single-file runs

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

### Manual native file transfers

This path currently has offline fixture coverage only. Connected manual transfer remains unqualified, and each recipient still needs its own supported authentication and provider permission. Google consumer CLI launch is unavailable and cannot serve as a transfer recipient.

New file runs can opt into a finite recipient list. Add `--handoff-target` for each allowed file profile during `prepare-native`. Repository work and older runs do not support this option. Targets default to ordinary usage; only `openai-file-v1:existing-credits` opts that recipient into existing credits. The writer's credit choice does not authorize recipient spending.

```sh
pnpm crewkite task prepare-native <task-id> openai-file-v1 net.mjs --policy native-policy.json --native-trust --source-consent --handoff-target anthropic-file-v1 --handoff-target openai-file-v1 --json
```

Choose the original limits before preparing. A Quick run with two writers, one check and one review needs at least four overall attempts and two launches per route. Launch allowance is per route; the overall attempt limit still applies. Every writer spends the same original minutes. The desktop offers an explicit two-writer choice of four attempts, twelve minutes and two launches per route. It starts nothing. Two reserved minutes cover the standard check/review path; full verification requires eleven remaining minutes. Later transfer cannot raise or replenish limits.

After normal Stop and confirmed process cleanup, inspect retained Changes. Prepare one previously allowed recipient with fresh trust and source-sharing consent:

```sh
pnpm crewkite task prepare-handoff <task-id> anthropic-file-v1 --native-trust --source-consent --confirm-subscription-only --json
pnpm crewkite task show <task-id> --json
pnpm crewkite task start-handoff <task-id> --json
```

OpenAI rejects subscription confirmation and permission-mode flags. Saved Google pilot settings remain readable, but do not authorize a new consumer launch. Add `--existing-credits` only when selecting that exact previously saved OpenAI recipient policy. No outgoing billing confirmation or native setting is inherited.

Preparation freezes the retained unverified file and task packet. It launches nothing and takes no new policy or grants file. Start binds the displayed pending preparation and starts a fresh writer, with no native-session resume. Each successor requires explicit authorization for its saved recipient and preparation. The original pin and role assignments remain unchanged. The controller rechecks source, ownership, recipient and remaining allowance. Files must fit every selected profile's 64 KiB bound. Earlier evidence remains history; changed work needs new checks and review.

Task show reports allowed recipients, current generation, pending recipient, expiry and preparation/start reasons. Reopening submits nothing. Stop cancels an unstarted transfer. If an outcome is uncertain, inspect the task and retry its exact saved receipt; no automatic retry or fallback occurs. Selecting a recipient establishes no provider entitlement or permission to use a subscription through another application. The [provider boundaries](../../docs/providers.md) retain their separate qualification limits.

### Native repository work

Repository work uses the `openai-repository-v1` profile and the committed repository. It accepts no target path or execution override:

```sh
pnpm crewkite task prepare-repository <task-id> openai-repository-v1 --policy repository-policy.json --native-trust --source-consent --json
pnpm crewkite task show <task-id> --json
pnpm crewkite task start <task-id> --json
```

The policy must include an unexpired one-use `run-native-tools` grant for the task and project name, alongside `write-scratch`. Add that grant explicitly to the policy above. Preparation never inserts it. The grant is consumed once at launch and permits multiple local commands during the bounded task. Omitting both consent flags requests exact saved repository consent. File consent cannot authorize local commands. Existing credits stay off unless `--existing-credits` is supplied.

The native client can edit independent scratch and run local commands. Its fixed settings are `workspace-write`, approval `never` and network access off. Requests needing native approval are refused. These settings do not establish separate filesystem or process containment by CrewKite. No account or native settings are changed.

Task show reports the frozen committed base, manifest hash, file and byte counts, execution settings and expiry. Inspect retained changes and export through the same commands as file proposals. A native command's exit status or summary establishes no check evidence. Resume and handoff remain unavailable.

### Candidate checks and review

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

This recipe takes no test-file or command options. Staging, all stages and cleanup share at most ten minutes. The original run needs at least eleven remaining minutes and two attempts, including the later review. The controller freezes toolchain and baseline identities before Start. Task show reports the fixed stages, platform, Node, Electron and Git versions and digests, lockfile and toolchain hashes. No dependencies are installed. Local code runs with your system permissions; no added filesystem or network containment is established.

Project Node tests run local code with your system permissions. Dependencies are not installed. Imports can use Node built-ins and files in the check copy. Paths are literal, with no globs or discovery; names with spaces need shell quotes. The controller freezes the committed files and refuses changed definitions before execution. Inspect `task show` before starting checks.

Preparation starts no checks or native review. Verification preparation first inventories the installed files. Omitting both consent flags requests exact saved evaluation consent. Reviewer credit spending defaults off independently of the writer. Add `--existing-credits` during evaluation preparation only when choosing that policy explicitly.

Task show reports the controller's evaluation stage, selected recipe and test files, exact file and hashes, saved reviewer and process-only independence, expiry, current start availability and remaining total attempts and minutes. The supplemental allowance permits one local check and one additional native review beneath those original run limits. Completed evidence remains visible after start permission expires. A failed or blocked check cannot authorize review. Task show also reports current local acceptance availability and its reason. Completed checks and review can make acceptance available. The destination still needs its own current grant or approval; inspection and export remain available.

### Combined tasks

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
  "integration": { "maximumMinutes": 3 },
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

Replace the IDs, child revisions, project name, paths and grant expiry with current values. Both targets must be distinct existing committed text files outside the protected checks. The full test collection must contain both replay collections and the separate interaction tests. Paths are literal. The controller freezes the common source and validates every selected check. The optional `integration.maximumMinutes` reserves private Git time within the total policy minutes; omitting it retains one minute. The total must cover both writer maxima, the reviewer maximum, four one-minute checks and integration. Each Git operation stays within sixty seconds and the remaining integration allowance. The CLI adds no grants or consent. Other finite writer selections retain their own billing attestations and observed configuration requirements; unavailable profiles remain unavailable.

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

### Local branch acceptance

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

### Uncertain actions

Action JSON contains `command` and `result`. Keep that receipt when the result is `outcome-unknown`. The saved command includes the original key, revision and approval binding. Inspect current state before choosing a retry:

```sh
pnpm crewkite retry receipt.json --json
```

Retry validates the bounded receipt file and resends its command unchanged. It never builds a new approval or refreshes an old grant. For an applied export receipt, `retry receipt.json --output new.patch` saves the same verified artifact without creating another export command. A failed local save still prints the original action receipt. Both interfaces use the controller's policy and permission rules.

Exit status is 0 for an applied action or a successful read, 2 for a controller refusal or uncertain result, and 1 for local input or connection errors. JSON preserves typed provider output. Plain output escapes terminal controls. Plain watch output contains event identities and revisions.

### Project commands and GitHub reads

Operations belong to one task. List one bounded page of up to twenty operations, then use its explicit continuation to inspect older entries. JSON preserves the exact page, including `nextBeforeId`; a non-null value means more history remains.

```sh
crewkite task operations TASK --limit 20 --json
crewkite task operations TASK --before-id OPERATION --json
crewkite task operation TASK OPERATION --json
```

Prepare a command from an explicit JSON file. Preparation freezes the committed source and executable identity and starts no command. The file names the same task, a `lint`, `test` or `build` recipe, executable, argument array, relative working directory and deadline from 1,000 to 86,400,000 milliseconds. An optional `environment` object accepts only the contract's named environment keys. Inputs must be regular files, cannot use a final symbolic link and must fit 262,144 bytes.

```json
{"taskId":"TASK","recipe":"test","executable":"/absolute/path/to/node","argv":["test.mjs"],"cwdRelative":".","deadlineMs":30000}
```

```sh
crewkite task command-prepare TASK --definition command.json --json
crewkite task operation TASK OPERATION --json
crewkite task command-start TASK OPERATION --definition-hash HASH --copy-committed-source --native-trust --json
crewkite task operation-stop TASK OPERATION --json
```

Command results are retained exploratory evidence from the reviewed committed HEAD. Candidate acceptance still requires its configured trusted checks and review.

Review the returned definition and its artifact hash before Start. Start re-reads that exact prepared operation and requires the same hash. Both flags are explicit authority for the committed-source copy and native tool execution. The CLI creates a fresh, single-use `run-native-tools` grant targeted to the hash, expiring five seconds after the loaded command deadline. Stop names the exact operation and does not load a workspace snapshot. Output artifacts use the existing `artifact read`, `verify` and `save` commands. An uncertain result stays retained; it does not authorize another launch.

GitHub reads use a separate JSON request with an explicit repository host, owner, name and immutable `headSha`. Supported kinds are `pull-request` with `pullRequest`, `workflow-run` with `runId` and numeric `attempt`, or `job-log` with those run fields and `jobId`. Remote IDs are decimal strings. These are fixed GET operations through the controller, with no login or remote mutation command.

```json
{"kind":"job-log","repository":{"host":"github.com","owner":"OWNER","name":"REPOSITORY"},"headSha":"EXACT_HEAD_SHA","runId":"123","attempt":1,"jobId":"456"}
```

```sh
crewkite task github TASK --request github-read.json --json
```

Mutation output retains the exact command key and result through the normal receipt format. `crewkite retry RECEIPT` resends that same command identity; it grants no new operation. Missing authentication, changed source and unavailable output keep their controller reason.
