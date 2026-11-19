# Task Operations

This unreleased candidate adds an Operations tab to a selected task. Required CI, a matching package and connected GitHub qualification remain pending. The public D2b UAT 02 download does not include these controls.

## Run a project command

Register a Git repository, create a task and open Operations. Choose lint, test or build, supply the executable and one argument per line, then prepare the command. Preparation inspects source and pins the executable; it does not copy or execute project code.

Review the exact committed HEAD, executable hash, arguments, relative working directory, environment and finite deadline. Dirty tracked edits and untracked files are excluded. Acknowledge native-code trust and explicitly start the reviewed command. Start copies committed source into private scratch and consumes a fresh, one-use grant for that exact definition. It does not run in the original checkout. Native tools are not a sandbox and may access the account or network with their ordinary authority.

Stop remains available while Start is pending. Completion requires retained output and observed process-group closure. An uncertain owner stays unknown; reopen never replays a command. Full stdout and stderr use the bounded artifact viewer. Operation history pages retain at most 20 summaries at a time.

These are exploratory commands against committed source. They do not qualify a final candidate or replace its configured trusted checks and review. This path still uses the existing 10,000-file and 64 MiB committed-source limits; large-source migration is separate.

## Read GitHub status and logs

Supply the exact repository host, owner, name and committed head, then choose PR metadata, a workflow run or a job log. Run reads include the run ID and attempt; job logs also include the job ID. The registered repository origin must match, and the head must be the checkout head or the accepted commit of a chat thread on the task. The installed native client must already be configured outside CrewKite.

The controller uses fixed GET-only requests. It retains the request identity, status, fetch time and full result/log artifacts. A displayed URL is copyable text. Reads cannot push, create a PR, rerun, cancel or dispatch a workflow. A failed or unavailable read keeps its reason separate from process ownership. The candidate has an offline executable fixture; it has not yet been qualified against a live GitHub repository.

## Write to GitHub

Every write to a GitHub remote starts as a proposal. It names the repository, the branch or pull request and the head commit the person saw, and its preview shows the exact command. Nothing runs until the person confirms it. The controller journals the write as sent the moment before its process starts, through the same process owner as project commands, and records what the remote made: the pull request number, the reply's comment ID, the new run attempt or the merge commit. Push in the Changes tab confirms with its own question, and the push names the branch and commit that question showed, so a thread that accepted again since refuses it. A push still running or unknown holds every push of the thread, whatever branch it went to, so its row shows with Check in place of Push. `crewkite thread push` prints the commit, and `--commit` holds the push to it. Open pull request proposes and answers with the preview to confirm. Every other write in the tab is a proposal shown in place with its preview, and Confirm sends it.

| Write | Command |
|-------|---------|
| Push | `git push <remote> <commit>:refs/heads/<branch> --force-with-lease=refs/heads/<branch>:<expected>` |
| Open, update or reply on a pull request | `gh api --method POST` or `PATCH` on the pull request endpoints, with the JSON body in a file |
| Ready or draft | `gh pr ready <number> --repo <host>/<owner>/<repo>`, with `--undo` for draft |
| Rerun | `gh api --method POST .../actions/runs/<run>/rerun-failed-jobs` or `.../rerun` |
| Merge | `gh api --method PUT .../pulls/<number>/merge` with the method and the head sha |

A pull request with an empty description gets one built from the thread: the plan's goal, each slice with its outcome and the turn that ran it, and the files the branch changes. Before a write to a pull request or a run is sent, a read checks that the head is still the one the person saw. A merge also reads branch protection, the branch rules and the head's check runs and statuses. A required check that is not green, a moved head or a merge state GitHub blocks refuses the merge with the reason, and nothing is sent. The merge call carries the head sha, so GitHub itself refuses any other head. Nothing asks for an administrator bypass. The merge method comes from the repository policy.

A merge proposal checks the merge before it records anything. It fetches the pull request's base from the project remote that points at the pull request's repository, the one the branch was pushed to when it does, and merges the head onto it in a scratch repository. A repository no remote of the project names refuses before any fetch. A conflict refuses the proposal with the conflicting files. `CheckChatMerge` runs the same check for the Resolve conflicts button, and on a conflict it moves the merge into the thread's copy for one fixer turn. A clean head then reads the same branch protection, rules and checks the send reads, and the proposal names the required checks it found green. The send reads them again. Before the click, the Changes tab makes the same reads through `ReadMergeReadiness` once the checks on the head are green, and Merge either names the required checks or waits with GitHub's reason, such as a review branch protection asks for. `crewkite thread merge-check` runs the conflict check from a terminal and prints what it found.

A write whose process dies, times out or answers in a form the controller cannot read is unknown. It holds its kind for the thread, and the thread cannot be deleted under it. Reconcile reads the remote: the branch tip, an open pull request at the pushed head, a reply from the person's account, a newer run attempt or the merge commit. A pull request from the branch that was closed without a merge is never taken as the write, however new it is. A read that finds nothing settles the write as refused only once its process is proven gone, and a remote that cannot be read leaves it unknown. Startup marks a write that was being sent as unknown. Nothing sends a write again on its own.

When Check in the Changes tab reads GitHub and still cannot tell, the row offers I checked GitHub. The person picks Mark as done on GitHub or Mark as not sent, writes a short note on what they saw, and confirms. The write is then recorded as applied or refused on their word, with the time and the note, and its kind and the thread delete are free again. When that Check found the write's process still running, the form says so and that it may still reach GitHub, and the person can still settle it. The controller takes that word only after its own read failed, and it sends nothing. A pull request marked as done has no number here, so Open pull request asks once more, and GitHub's answer names the one that is open. A merge marked as done names no merge commit. A push marked as done reaches the thread at the next Push, which sends nothing.

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

Focused journal, shared process-owner, command, GitHub adapter, client timeout and CLI fixtures pass. The existing desktop journey passes a real local command, Stop before Start returns, unchanged original source/index, retained output, bounded history and controller reopen. These checks use disposable repositories and no model inference. They do not establish live GitHub credentials, Python candidate qualification or large-source support. Remote writes are checked against a fake gh with recorded GitHub responses and a local bare remote, never a live repository.
