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
| `task start <task-id>` | Start the run prepared in the desktop |
| `task stop <task-id>` | Request stop using the current task revision |
| `task resume <task-id>` | Resume an interrupted run through controller admission |
| `task approve <approval-id>` | Approve the exact pending binding from the snapshot |
| `task deny <approval-id>` | Deny that binding |

`--json` produces one JSON object for reads and actions. Watch emits one object per line, beginning with its task snapshot. A fresh snapshot replaces that state after a history gap. Ctrl+C stops watching.

Watch retains its cursor while the controller is offline. If the bounded reconnect window ends, it prints the next action and exits with status 1. Start the controller and run watch again to reconnect explicitly.

## Uncertain actions

Action JSON contains `command` and `result`. Keep that receipt when the result is `outcome-unknown`. The saved command includes the original key, revision and approval binding. Inspect current state before choosing a retry:

```sh
pnpm crewkite retry receipt.json --json
```

Retry validates the bounded receipt file and resends its command unchanged. It never builds a new approval or refreshes an old grant. Task policy is prepared in the desktop, so this CLI has no parallel permission rules.

Exit status is 0 for an applied action or a successful read, 2 for a controller refusal or uncertain result, and 1 for local input or connection errors. Provider output is JSON-escaped in watch mode. Plain watch output contains event identities and revisions.
