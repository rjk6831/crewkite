# CLI

The CLI connects to the same controller as the desktop. It reads `CREWKITE_HOME`, defaults to `~/.crewkite`, and accepts `--home path` for isolated state.

```sh
pnpm crewkite task list --json
pnpm crewkite health --json
```

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

`--json` produces one JSON object for reads and actions. Watch emits one object per line, beginning with its task snapshot. A fresh snapshot replaces that state after a history gap. Ctrl+C stops watching.

Watch retains its cursor while the controller is offline. If the bounded reconnect window ends, it prints the next action and exits with status 1. Start the controller and run watch again to reconnect explicitly.

## Native single-file runs

Create the project and draft task in the desktop. List the controller's supported native profiles:

```sh
pnpm crewkite native profiles --json
```

The snapshot reports profile availability, its reason, client version, model, effort and bounds. OpenAI and Anthropic have bounded local native paths. Google consumer automatic launch reports `provider-policy-restricted` and refuses before native discovery. The [dated provider boundaries](../../docs/providers.md#current-availability) explain these restrictions. Anthropic and Google report requested effort separately from unobserved effective effort and service tier. A missing qualification date is shown as pending. Preparation requires an available profile ID. It accepts no executable, digest or model override.

Save a policy JSON file using the existing policy schema. This example grants one scratch write and one export. Replace the sample task ID and project name with the desktop values, and choose a future expiration before preparing the run:

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

The native path retains a single-file candidate. Stop waits for owned cleanup. Resume cannot submit another native writer turn for retained work. Checks and review require separate preparation and explicit starts. Handoff remains unavailable. Local acceptance requires matching completed checks and review, plus its own destination permission.

```sh
pnpm crewkite task changes <task-id>
pnpm crewkite task export <task-id> --output candidate.patch --json
```

A saved patch can be carried to a provider's native app manually. CrewKite does not open that app or import its result automatically.

Export reads bounded artifact pages and verifies identity, offsets, length and checksum before creating the destination. Existing files are never overwritten. Plain diff output escapes terminal control characters. If export needs approval, its receipt includes the next approval command. Approve that export with `task approve <approval-id> --output new.patch`, or retry the saved export approval receipt with `--output new.patch` after inspecting its result.

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

Exit status is 0 for an applied action or a successful read, 2 for a controller refusal or uncertain result, and 1 for local input or connection errors. Provider output is JSON-escaped in watch mode. Plain watch output contains event identities and revisions.
