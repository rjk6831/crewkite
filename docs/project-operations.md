# Task Operations

This unreleased candidate adds an Operations tab to a selected task. Required CI, a matching package and connected GitHub qualification remain pending. The public D2b UAT 02 download does not include these controls.

## Run a project command

Register a Git repository, create a task and open Operations. Choose lint, test or build, supply the executable and one argument per line, then prepare the command. Preparation inspects source and pins the executable; it does not copy or execute project code.

Review the exact committed HEAD, executable hash, arguments, relative working directory, environment and finite deadline. Dirty tracked edits and untracked files are excluded. Acknowledge native-code trust and explicitly start the reviewed command. Start copies committed source into private scratch and consumes a fresh, one-use grant for that exact definition. It does not run in the original checkout. Native tools are not a sandbox and may access the account or network with their ordinary authority.

Stop remains available while Start is pending. Completion requires retained output and observed process-group closure. An uncertain owner stays unknown; reopen never replays a command. Full stdout and stderr use the bounded artifact viewer. Operation history pages retain at most 20 summaries at a time.

These are exploratory commands against committed source. They do not qualify a final candidate or replace its configured trusted checks and review. This path still uses the existing 10,000-file and 64 MiB committed-source limits; large-source migration is separate.

## Read GitHub status and logs

Supply the exact repository host, owner, name and committed head, then choose PR metadata, a workflow run or a job log. Run reads include the run ID and attempt; job logs also include the job ID. The registered repository origin and head must match. The installed native client must already be configured outside CrewKite.

The controller uses fixed GET-only requests. It retains the request identity, status, fetch time and full result/log artifacts. A displayed URL is copyable text. Reads cannot push, create a PR, rerun, cancel or dispatch a workflow. A failed or unavailable read keeps its reason separate from process ownership. The candidate has an offline executable fixture; it has not yet been qualified against a live GitHub repository.

## CLI

The same operations are available without a workspace snapshot:

```text
crewkite task operations TASK [--before-id OP --limit 20]
crewkite task operation TASK OP
crewkite task command-prepare TASK --definition recipe.json
crewkite task command-start TASK OP --definition-hash HASH --copy-committed-source --native-trust
crewkite task operation-stop TASK OP
crewkite task github TASK --request github.json
```

See the [CLI guide](../apps/cli/README.md) for strict JSON definitions and request examples. History reports an explicit continuation to older operations.

## Evidence and limits

Focused journal, shared process-owner, command, GitHub adapter, client timeout and CLI fixtures pass. The existing desktop journey passes a real local command, Stop before Start returns, unchanged original source/index, retained output, bounded history and controller reopen. These checks use disposable repositories and no model inference. They do not establish live GitHub credentials, Python candidate qualification, large-source support or remote mutation authority.
