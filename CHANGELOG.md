# Changelog

This file lists what changed in each release, newest first. A release is tagged `v` followed by its version. See [releases](docs/releases.md).

## Unreleased

### 0.1.0

This version gathers rc-05, rc-05+ and sprint 2. Every package.json and the version CrewKite reports carry the same number.

rc-05

- I built the desktop around a chat thread that streams the reply, shows tool calls and diffs, and asks before an edit or a command.
- I connected OpenAI, Anthropic, Google and a local model as thread families, each through its own signed in client, with the model and effort chosen for each message.
- I added handoff, which moves a thread to another family and keeps its messages and edited files.
- I added the Full crew preset, where an orchestrator proposes a plan of up to 8 slices and the controller assigns each one by allowance and difficulty.
- I added read-only thread tools, so a model can read what another model did.
- I added Changes, Discard and Accept to a new local branch, with Push after a confirmation and pull requests through gh.

rc-05+

- I made thread tools appear only on turns that have them, and made the control socket findable through a record in the home folder.
- I added the interactive terminal mode with slash commands, mentions and `crewkite -p`.
- I let independent plan slices run side by side in their own copies, with a file level replay and Blocked slices.
- I made scratch copies clone where the volume allows, and made Changes, Discard and Accept compare by object ID.
- I added the person's own MCP servers, off for every thread until one is turned on for it.
- I added composer mentions, slash commands, the instruction chip and saved prompts to the desktop.
- I added project checks to the crew chain, each run after asking the thread's permission.
- I added an extension seam with a versioned contract, off by default.

Sprint 2

- I added usage analytics for a thread and for a project, with a CSV export in the desktop and in `crewkite usage`.
- I added search over thread history in the desktop rail and in `crewkite search`.
- I added project notes that the controller sends with every turn.
- I added diagnostics export and a crash notice, with secrets, home paths and email addresses removed.
- I added a first run welcome flow and a command palette with fuzzy search.
- I added thread export to Markdown and to a read-only share page, in the desktop and in `crewkite export`.
- I held Google turns until the person acknowledges Google's terms.
- I added a benchmark harness with 30 tasks taken from the repository history.
- I set every package to 0.1.0, read the version from one constant, and added `crewkite --version`, `-v`, `version` and `help`.
- I made the CLI refuse a malformed thread or project ID in one line with status 2, and added `crewkite thread changes`.
- I made `crewkite thread new` and `crewkite -p` remove the thread they made when the first message is refused.
- I made print mode say when it loses the controller, and keep trying for the same time as before.
- I made health report `git was not found` or `git failed to run`, and made a refused `project add` say the same.
- I added `pnpm desktop`, which opens the desktop from source on the real controller and your own CrewKite home.
- I made the Changes list load in pages with no file cap, and added Accept and Discard for each hunk.
- I added review comments that quote the lines of a hunk and join the thread as a message.
- I made long threads mount only the rows near the screen.
- I made Accept batch its object lookups and writes, and made hunk actions check hunk bytes, folders and fences before acting.
- I confined plan slice reviews to their own copy, and held Blocked slices out of the thread's copy.
- I cut the thread history sent to a Local model to the room its prompt has left.
- I held git to the scratch copy for every client and check.
- I back up the database before a migration, and keep the newest backup when I prune.
- I released the message queue after a restart, and made Stop report how many messages it cleared.
- I made the shared redaction close more secret shapes, and made a crash capture leave the way a process fails unchanged.
- I made the Anthropic turn refuse a pre-placed `mcp.json` or link.
- I kept a gauge row for every provider, put the Google terms checkbox inline with its label, and showed Ctrl K for search off macOS.
- I skipped the welcome for anyone who already has a project.
- I let chat accept a range of client builds within the tested major version, and named the found version on each provider card.
- I added a Linux preview from source for OpenAI, Anthropic and Local, with Linux CI.
- I moved the `--json` lines to `v: 3`, because this sprint added fields to the thread, turn and event shapes they embed.
- I removed the 100,000-file cap on a thread's scratch copy and check free disk space before the copy instead.
- I made the Local search cover every file and say how many were too large to search, and let it read lines of a file of any size.
- I made pasted text longer than one message go in as a file.
- I removed the shipped Anthropic model list: the picker shows the client's rows, then model IDs this home ran turns on.
- I let effort levels be any name a client reports, so a new level needs no release.
