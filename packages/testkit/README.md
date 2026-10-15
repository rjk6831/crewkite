# Scripted testkit

The testkit supplies synthetic source and executable workers for controller tests. Every route is fake. Workers retain real edits and report events through the shared contracts. They never report a check pass.

## Entry points

| Import | Use |
|--------|-----|
| `@crewkite/testkit` | Browser-safe demo fixtures, an injected clock and deterministic IDs |
| `@crewkite/testkit/repository` | A synthetic Git repository and the minor-amount challenge |
| `@crewkite/testkit/worker` | The Node executable path, exported as `fakeWorkerPath` |

`createDemoFixtures(now)` returns a snapshot, a draft task, role assignments and policy. The initial snapshot has one project and four routes. The draft task is separate so a client can show it before creation. Every allowance observation names its fixture source. The policy grants bind the fixture task ID; a controller that creates a different task must issue grants for that task.

`createTestClock(start)` exposes `now()` and `advance(milliseconds)`. `createTestIds(start, seed)` returns a function that takes an entity prefix. Both use fixed inputs and read no wall clock. ID sequences are isolated; give each independent writer its own seed.

## Synthetic source

`createSyntheticRepository(directory)` accepts a new or empty directory. It returns the committed base, source status, index entries and a sentinel manifest. The source has staged, unstaged and untracked changes, a binary file and an executable file. The builder uses its own fixture commit identity and ignores ambient Git configuration.

The challenge starts with a failing `net.mjs` implementation. `net.test.mjs`, `cli.mjs` and the browser form already call that function. A worker replaces only `net.mjs`. Checks must run against the retained candidate:

```sh
node --test net.test.mjs
node cli.mjs 3000 500
```

Copy the selected committed base into an independent scratch directory before launching a worker. The controller owns source isolation and preservation checks. Keep the returned source status, index and sentinel hashes for that comparison.

## Worker protocol

Spawn the worker with Node and piped stdin, stdout and stderr. Each stdin and stdout frame is one UTF-8 JSON line validated by `FakeWorkerInputSchema` or `FakeWorkerEventSchema`. Input is capped at 1 MiB. Send one `start` frame with the attempt, generation, scratch directory, scenario and task outcome. The `ready` event confirms that binding. Later events belong to the same process stream.

The first checkpoint confirms that edits are retained. It says explicitly that checks have not run. Use event arrival to coordinate interruptions.

| Scenario | Behavior |
|----------|----------|
| `complete` | Retain edits, emit a checkpoint and complete |
| `approval` | Retain edits, request `run-check` for `node --test`, then wait for a matching approval binding |
| `approval-reserve` | Request approval, then emit the reserve observation and wait for checkpoint or stop in the same attempt |
| `reserve` | Retain edits, emit 5% weekly allowance and wait for `checkpoint` or `stop` before stopping |
| `crash` | Retain edits and wait at the checkpoint; the next `checkpoint` input exits with code 17 and no terminal event |
| `stubborn` | Start an owned descendant, retain edits and wait; `stop` exits the parent while the descendant remains |

Reserve mode requires `CREWKITE_FAKE_ROUTE_ID` and `CREWKITE_FAKE_OBSERVED_AT` from the host's injected route and clock. It reads no provider environment or account state.

Approval frames authorize the named host action. The controller must honor a denial before running real checks. A worker terminal event carries no check evidence.

Stubborn mode acknowledges descendant readiness before emitting its checkpoint. The output marker is JSON text with `fixture: "stubborn-child-ready"` and its PID. The descendant inherits the worker process group and stdout. It ignores SIGINT and SIGTERM. Parent exit cannot prove quiescence.

The host must launch an isolated process group. Cleanup explicitly kills that group and waits for stdout to close. SIGUSR2 releases the descendant alone when a test needs that control. Every test that starts stubborn mode owns cleanup, including failure paths.

## Scripted reviews

`fakeReviewWorkerPath` selects a separate executable. Send one shared `review` input with the full job, fresh candidate directory, criteria and optional guidance. It emits `ready`, a job-bound `review` result and a terminal event. A completed process can still return a failed or blocked review.

Each method inspects fixed patterns in the synthetic `net.mjs` challenge. Keep it simple checks its export scope. Challenge assumptions checks its input guard. Second opinion checks its clamp. Round-robin checks one of those facts per cycle. Results identify themselves as SCRIPTED. These patterns prove job plumbing; they make no claim about model judgment or general code quality.

The executable opens candidate files for reading only. It never runs candidate code or changes files. Missing, linked, oversized or invalid UTF-8 source blocks the review. The controller owns the full candidate manifest check before and after execution and matches every returned job field before recording evidence.
