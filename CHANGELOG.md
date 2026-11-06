# Changelog

This file lists what changed in each release, newest first. A release is tagged `v` followed by its version. See [releases](docs/releases.md).

## Unreleased

### 0.1.0

This version gathers the preview rounds through the provider connection and responsiveness corrections. Every package.json and the version CrewKite reports carry the same number. Installed release qualification remains pending.

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

rc-05++

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
- I released the message queue after a restart. Stop keeps queued messages paused and reports how many are waiting.
- I made the shared redaction close more secret shapes, and made a crash capture leave the way a process fails unchanged.
- I made the Anthropic turn refuse a pre-placed `mcp.json` or link.
- I kept a gauge row for every provider, put the Google terms checkbox inline with its label, and showed Ctrl K for search off macOS.
- I skipped the welcome for anyone who already has a project.
- I let chat accept a range of client builds within the tested major version, and named the found version on each provider card. The later OpenAI protocol checks below replace that family's version gate.
- I added a Linux preview from source for OpenAI, Anthropic and Local, with Linux CI.
- I versioned the `--json` lines with the thread, turn and event shapes they embed. The current line version is `v: 6`.
- I removed the 100,000-file cap on a thread's scratch copy and check free disk space before the copy instead.
- I made the Local search cover every file and say how many were too large to search, and let it read lines of a file of any size.
- I made pasted text longer than one message go in as a file.
- I removed the shipped Anthropic model list: the picker shows the client's rows, then model IDs this home ran turns on.
- I let effort levels be any name a client reports, so a new level needs no release.
- I showed the subagents a provider client starts under the tool call that started them, with a live count on the turn chip and each subagent's latest action on the card.
- I made a client item or tool call that CrewKite has no reader for show as a card.
- I added an Allow subagents switch to each crew role that passes each client's own control. It is now on by default for every family after the OpenAI child approval check.

d3-rc5

- I made one Google Connect follow download, verification, initialization, sign-in and model discovery, with progress and retries at the failed step. Google quota reads wait for connection.
- I moved saved crews and the default crew into the controller, and added the same `/model` and `/crew` pickers to the CLI.
- I kept read-only commands inside the scratch copy and assigned plan slices to the crew's models, with the fixer taking a hard slice and Local taking work only through a Local crew role. Only an explicit exclusion in the message rules out a provider.
- I made Local Connect probe the saved endpoint, ask for a token only when needed and show a model pick while it is being saved.

d3-rc7

- I kept provider setup responsive while Google client verification runs and reused the verified cached client on reconnect.
- I made Local Connect use the prefilled loopback endpoint, choose the only loaded eligible model and wait for a model read already running.
- I made Allow for this thread answer later asks of the same kind during the running turn, under the same scratch-copy checks.
- I named Google's extra allowance windows Non-Gemini models, 5 h and Non-Gemini models, weekly, and kept the smaller model gauge visible.

Follow-up fixes (#125)

- I kept Google import checks valid while unrelated work changes the controller home's directory times, with the managed client bytes and identity still checked.
- I retried the first OpenAI quota read once when it stops early, and made the card name a read that did not finish.
- I retried one slow workspace read after setup before showing its error.

d3-rc11

- I required an explicit first Connect per provider on each device. Later launches reconnect the providers already connected, using the saved endpoint and each client's sign-in.
- I gave OpenAI its own client home and sign-in flow on the provider card. CrewKite's saved writer threads use the person's first line as their name and stay out of the person's own client app.
- I checked OpenAI requests against the client's protocol. A named read-only permission profile must be proven by the reply; another reply uses the read-only fallback with scratch command checks and permission asks.
- I ran side questions beside the builder, kept a reason on every stopped turn and folded automatic permission answers under their tool cards.
- I made Local setup safe to send again and kept its card clear of uncertain command receipts.
- I moved large client digests to a worker, checked Google's two files once per connect and ran their signature checks together. Google progress names the file being checked, elapsed time and the retry count.
- I added descriptions to Flight mode and Permissions and account-free protocol checks for provider client changes.

Release polish

- I replaced every native dropdown in the desktop app with CrewKite's own, with the same values, groups, keys and closed sizes, so none opens a system popup. A source check keeps native selects out.
- I added Run tests to Project checks. It runs the project's test command in the thread's copy with no model turn, asks first unless the thread allows the command, and keeps the exit status and output with the thread's checks.
- CLI JSON lines move to version 7, since a check run can now come from Run tests.
