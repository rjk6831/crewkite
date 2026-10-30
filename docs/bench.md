# Benchmark harness

I use this harness to compare model families and effort settings on the same small tasks. Each task comes from a real commit in this repository's history. The harness gives the task text to a chat thread through the controller, lets the turn run, and then runs the task's checks in the thread's scratch copy. It records what happened. It does not decide which family is better, and it ships no efficiency mode.

## What it measures

For each task, family, model and effort, one run file records:

- whether the checks passed, with the exit code, time and the last lines of output for each check;
- the wall time of the turn;
- tokens in and out where the client reported them. When a client reports nothing, the field stays null and the table prints unknown. A missing report is never counted as zero, and a total shows how many tasks it leaves out;
- the number of files the turn changed;
- the findings a review turn stated on its `Findings: N` line, when I run with `--review`;
- a `bugsFoundAfter` field. It stays null until I fill it in by hand after a later pass over the accepted changes. Null means I have not looked yet, and zero means I looked and found none.

A task that failed, errored, timed out or was left out appears in the file with its reason. The summary line counts requested, ran, passed, failed, errored, timed out and excluded tasks.

## Running it

From the repository root:

```
pnpm bench --family <family> --model <id> --effort <effort> --tasks <ids|all>
```

`--tasks` takes a comma separated list of task ids, or `all`. With `all`, a task that has no verification record is skipped and listed as an exclusion. Naming an unverified task by id runs it and marks it unverified in the file.

The run uses the clients installed and signed in on this machine, through the normal chat adapters and the controller's chat thread path. The harness makes no network calls of its own. It starts a controller on a home inside its work folder, registers a project made from the task's base commit, opens a thread, sets the thread's permission policy to allow all, since the turn can only touch the scratch copy, sends the task text, and waits for the turn to end.

Other options:

- `--review` runs a review turn on each finished task and records its findings.
- `--timeout-minutes <n>` limits one work turn. The default is 30.
- `--out <folder>` sets where the run files go. The default is `internal/bench`.
- `--keep` keeps the work folder with each task's scratch copy and check copy.
- `--scripted` replaces the provider with a scripted adapter that writes each task's solution files. I use it in CI to test the mechanics. A scripted run says nothing about any model.
- `--tasks-dir <folder>` adds a folder of task files. Give it more than once to add several.

A run writes `<run id>.json` and `<run id>.md` in the output folder. `pnpm bench report <run.json>` renders the table again from the JSON, for example after I fill in `bugsFoundAfter`.

## Task files

A task is one JSON file named `<id>.json`. The schema in `packages/bench/src/manifest.ts` checks it when the folder loads. The fields are:

- `id`, in lower case with hyphens, and `title`.
- `repository`: `self` for this repository, or an absolute path to another checkout on this machine.
- `base`: the commit the thread starts from. For tasks taken from history, it is the parent of the fix.
- `solution`: the commit that holds the finished change.
- `text`: what I ask the model for. I write it from the intent of the commit and never quote its diff. The schema refuses text that contains diff headers or hunk lines.
- `hidden`: files that exist at the solution commit and are copied over the base before the checks run, such as the tests that describe the change. The model never sees them.
- `checks`: commands run in the scratch copy, each with a command, arguments and a timeout. They run without a shell.
- `difficulty` (easy, medium or hard) and `tags`.
- `verification`: written by `pnpm bench verify --write`.

A task counts as verified when its checks fail on the base with the hidden files in place and pass on the solution. `pnpm bench verify` does that for each task in clean copies made with `git archive`, and `--write` stores the result, the Node version and the names of the checks that failed on the base. A task that cannot be verified is not shipped.

In the tasks shipped here, a check fails on the base in one of two ways. Most fail an assertion about behavior. Some fail because the hidden test imports a module or an export that the change adds, so the base cannot load it. Those still show the check does not pass without the change, and they depend on the task text to name the module and its exports. The `verification` record keeps the check names, and a run file lets me look at the output of any check.

## Adding PULL tasks from my own checkout

PULL lives in a checkout on my Mac, so its tasks are not in this repository. To add them:

1. Make a folder outside this repository, for example `~/bench-pull/tasks`.
2. For each task, write a file with `repository` set to the absolute path of the PULL checkout, `base` as a commit before the fix and `solution` as the commit with the fix.
3. Put the tests that describe the fix in `hidden` and the command that runs them in `checks`.
4. Run `pnpm bench verify --tasks-dir ~/bench-pull/tasks --tasks all --write`. Tasks that fail to verify stay out of `all` runs.
5. Run with `--tasks-dir ~/bench-pull/tasks` and the ids.

The harness reads that checkout with `git archive` and never writes to it. A task file with an absolute `repository` that is missing, or a commit that does not exist, becomes an exclusion in the run file, so the loss is visible.

## What I will claim from a run

An advantage claim needs the whole run file behind it. When I say one family or effort setting beat another, I publish the failures and the exclusions next to the passes, with the counts from the summary line. I also say how many tasks reported tokens and how many did not. A result from `--scripted` is never evidence about a model. A result with unverified tasks says so.

The harness has limits that I list here. The checks measure whether a change passes tests I chose, and they do not measure code quality. Tasks come from one repository, so they say little about other codebases. A live run depends on the installed client, its version and the account's limits on the day. Wall time includes queueing at the provider. Only a person can fill in `bugsFoundAfter`, and I count it only for the runs where I did.
