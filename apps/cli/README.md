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
| `task changes <task-id>` | Read the retained candidate diff |
| `task export <task-id> --output new.patch` | Request export and save verified patch bytes to a new file |

`--json` produces one JSON object for reads and actions. Watch emits one object per line, beginning with its task snapshot. A fresh snapshot replaces that state after a history gap. Ctrl+C stops watching.

Watch retains its cursor while the controller is offline. If the bounded reconnect window ends, it prints the next action and exits with status 1. Start the controller and run watch again to reconnect explicitly.

## Native single-file runs

Create the project and draft task in the desktop. List the controller's supported native profiles:

```sh
pnpm crewkite native profiles --json
```

The snapshot reports profile availability, its reason, client version, model, effort and bounds. The CLI accepts a listed profile ID. It accepts no executable, digest or model override.

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

Task show includes the matching native run and source, frozen target path, base hash, byte count, consent expiry and stage. Older retained runs can report unknown target facts or expiry.

Preparation spends no inference. Start rechecks controller admission and launches the saved run. Without both consent flags, preparation requests the controller's exact saved consent. A single flag is rejected. Changed source, target, criteria, policy, profile or billing choice can invalidate that consent.

Existing-credit spending defaults off. Add `--existing-credits` only when choosing that policy explicitly. Available included usage does not establish a provider-enforced hard billing cap. Native trust and billing limits are described in [provider routes](../../docs/providers.md).

The current native path retains an unverified single-file candidate. Stop waits for owned cleanup. Resume cannot submit another native turn for retained work. Scripted checks, review, handoff and acceptance remain unavailable for that candidate.

```sh
pnpm crewkite task changes <task-id>
pnpm crewkite task export <task-id> --output candidate.patch --json
```

Export reads bounded artifact pages and verifies identity, offsets, length and checksum before creating the destination. Existing files are never overwritten. Plain diff output escapes terminal control characters. If export needs approval, its receipt contains the pending binding. Approve that export with `task approve <approval-id> --output new.patch`, or retry the saved export approval receipt with `--output new.patch` after inspecting its result.

## Uncertain actions

Action JSON contains `command` and `result`. Keep that receipt when the result is `outcome-unknown`. The saved command includes the original key, revision and approval binding. Inspect current state before choosing a retry:

```sh
pnpm crewkite retry receipt.json --json
```

Retry validates the bounded receipt file and resends its command unchanged. It never builds a new approval or refreshes an old grant. For an applied export receipt, `retry receipt.json --output new.patch` saves the same verified artifact without creating another export command. A failed local save still prints the original action receipt. Both interfaces use the controller's policy and permission rules.

Exit status is 0 for an applied action or a successful read, 2 for a controller refusal or uncertain result, and 1 for local input or connection errors. Provider output is JSON-escaped in watch mode. Plain watch output contains event identities and revisions.
