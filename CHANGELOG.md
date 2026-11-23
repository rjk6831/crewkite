# Changelog

This file lists what changed in each release, newest first. A release is tagged `v` followed by its version. See [releases](docs/releases.md).

## Unreleased

### 0.2.0

This release adds recipes, loops and results, a design system per project, checks after every writing turn and at Accept, GitHub writes from the thread and API connections that spend only where I assign them. It also fixes the Google hold that kept a Ready setup refusing every read, which the [Google metadata hold](docs/google-metadata-hold.md) page records, and makes CrewKite say what it cannot confirm. It moves the database from schema 21 to 27. Two parts are in the build and switched off: checklist work for loops, and report runs. Installed upgrade qualification from 0.1.0 remains pending, as [releases](docs/releases.md#version-020) records.

- I added recipes. A recipe is one JSON file in the project, in `.crewkite/recipes` unless you pick another folder. It holds a crew with a model and effort per role, the flight mode, the permission policy, one set of check commands, the handoff setting and the most slices a request may split into. Only a saved version runs, and every saved version is kept. The Recipes page edits a recipe, shows each change before the save and runs the saved version on a request. Save as recipe on a finished plan thread drafts one from that thread. [Proposed ADR 0057](docs/adr/0057-a-recipe-is-one-file-and-only-a-saved-version-runs.md) records the rules.
- I added loops. A recipe with a trigger starts on its own: every interval of 15 minutes or more, once at a set time, or when a provider reports its allowance has reset. A loop cannot be saved without a run limit, a waiting limit and an allowance limit for every metered provider a run can reach. A start passes over when a reading is missing, 15 minutes old or above its limit. CrewKite never estimates a reading. Two dry runs in a row or the run limit stop the loop, and the waiting limit pauses it. A run that stops to ask waits for you and counts toward that limit. Loops start only while the desktop or a CLI session is attached, and after a restart a loop makes up at most one missed start. [Proposed ADR 0058](docs/adr/0058-a-schedule-cannot-be-saved-without-a-budget.md) records the rules.
- Saving a loop approves its check commands for the runs it starts, while each command resolves to the same script. A changed script asks before it runs, as it does on a thread. A loop never raises a permission and never accepts, pushes or merges.
- The Loops view lists every loop with its next run and last result, with Pause, Resume, Restart and Open last run. `crewkite loop list`, `pause`, `resume` and `restart` do the same in a terminal, and `crewkite recipe list`, `show` and `run` work with recipes.
- I added results. The controller keeps one record per plan step on this device: the role, provider, model and effort, what the first check and the first review said, how many fix rounds it took and what became of the change. A step's allowance use is stored only when the reading after it proves no other turn on that provider ran in between. The Results view counts the records per recipe and per role, Export JSON writes them to a file, and `crewkite results` prints and exports them. [Proposed ADR 0059](docs/adr/0059-results-stay-on-the-device.md) keeps them on the device.
- Checklist work is switched off. A loop that names a checklist file is refused at the save and at the run, and the editor shows A checklist file as not available. The reader goes line by line, and each of five review rounds found markup it read wrongly. I will not give a run nobody watches a line that is not a visible open item. It comes on once the file is read with a full parser.
- Report runs are switched off. A report recipe's slices only read, a challenger argues against the findings and the orchestrator writes the ones that stand into one message. Running one is refused, a report recipe with a trigger is refused at the save, and the editor shows Report only as not available. Accept is not yet refused on a report thread, and a continued report's zero count is not yet checked against every reply.
- Settings has a Project setup card with one row each for Context, Hooks, Loops, Graphs and Results, and [Terms](docs/terms.md) says what each word means here.
- I made the project's checks run as a gate after each builder, fixer and Solo turn in Balanced and Glide, and after each merge of a plan slice into the thread's copy. A failure goes to the fixer, two fixes at most. A plan that still fails stops and names the slice, and Retry runs it again. The checks no longer run once at the plan's close.
- I made Accept run the thread's required checks on the exact tree it will commit and refuse with each failing check named. Accept can be cancelled while its checks run.
- I added dependency preparation for npm and pnpm projects. The thread's copy gets its own installed dependencies with no link back to the project, up to 2 GiB, and any change to the lockfile or the install inputs makes them stale. The gate after a writing turn, each plan slice and Accept prepare the copy they need. Prepare dependencies sits where a check says it needs it, and `crewkite thread prepare` does it in a terminal.
- The Work tab says what holds a thread and its plan, with the next step for each, and lists the plan's slices with their owner, dependencies and check results. A thread held by a check whose process was never recorded, or that nothing in this controller owns, can be released after you confirm and write what you checked, from the tab or with `crewkite thread release-check`. CrewKite proves nothing and signals nothing for it.
- I added writing rules. A writing turn on every provider gets the rules that are on in Settings, and the card previews and exports them to a file in the project. [Credits](docs/credits.md) names their source.
- I added a design system per project, kept as one file in the W3C tokens format with every saved version ([Proposed ADR 0055](docs/adr/0055-a-project-design-system-is-one-file-in-the-w3c-tokens-format.md)). An editor in Settings defines it, imports it from a token file or drafts it from a description in one read-only turn. Every writing role gets the same brief whichever provider runs it, and resumed Anthropic and Google turns get it again. A check in the controller flags raw colors, sizes and spacing outside the tokens in changed files, runs in the gate and at Accept, and the Design tab sends its findings to the fixer with their lines. A project can declare a preview, which runs only with the thread's permission, and the reviewer gets screenshots of its named views.
- CrewKite holds itself to the same rule. Its interface reads every color, size and spacing value from one token file, and the check finds nothing raw in it.
- I made every GitHub write go through one journal. That covers a push, opening or updating a pull request, marking it ready or draft, a review reply, a re-run and a merge. Each is shown before it is sent, needs a click, is recorded before it starts and is reconciled by reading GitHub after a crash. A write that no read can prove stays unknown until you settle it. Push sends the accepted commit by its ID with a lease on the branch's last push.
- The thread follows a pull request's CI. It lists every job with its status and log, sends a failed job's log to the fixer as a new turn and re-runs failed jobs. Review comments show beside the lines they refer to. A merge first checks that the branch merges cleanly onto its base, reads the base's protection and required checks, shows what lands and needs a click. After a merge the thread follows the merge commit's workflows and deployments.
- Accept checks each commit against the project's repository policy before it commits: Conventional Commits, subject length, sign-off, which Git identity, attribution lines and the branch pattern. The default matches this repository's own rules, and Accept suggests `feat: <title>` and a `feat/<slug>` branch.
- I added API connections ([Proposed ADR 0056](docs/adr/0056-an-api-connection-spends-only-where-i-assign-it.md)). An OpenAI or Anthropic API key signs in through the provider's own client in a folder of its own, and the key never passes through CrewKite. A connection spends only on the thread or crew role it is assigned to. Ranking, defaults, handoff and plan moves never reach one. The rail shows each connection's reported spend and the turns that reported none. Google has no API connection.
- Start at reset sends a message that stopped on a usage limit when that provider's window reopens. It never moves the message to another provider.
- I added a webhook. The controller posts one event to an address set in Settings when a piece of work finishes, fails, needs your approval or stops on a limit, and when a loop pauses or stops. The address is https, or http to this computer. The controller posts while CrewKite is running.
- `crewkite -p` and `crewkite thread watch` follow a thread until its whole workflow ends, crew chain, plan slices and checks included.
- Local connects to any OpenAI-compatible server on this machine or the private network, and its failure lines name the local server.
- Settings has a feedback card that builds a report you can read and edit before it goes anywhere, with Copy report and Open GitHub issue.
- I made Google recover from an interrupted metadata operation whose process is gone. Startup, a new Recover action and Stop on an unknown setup step probe the recorded process group with signal 0, and only a group that no longer exists releases the hold. The released result stays unknown, nothing replays and a late answer from it publishes nothing. Startup never releases an interrupted sign-in; Recover does, and then asks for a new sign-in.
- The Google card lists every operation that holds the provider, with its reason, even while setup reads Ready. It offers Recover only for an operation it can release.
- Every provider card states sign-in, models, quota age and any blocker as separate facts.
- I gave the OpenAI, Anthropic and Google cards the same three actions in the same order: Check again, Refresh models and Sign out. A line under them says which client copy runs. Sign out on Anthropic and Google ends CrewKite's connection only. The client stays signed in, and Connect uses it again.
- I made a quota reading age one way on the rail, the cards, the picker and the gauges. A percent read before its window reset shows as Unknown with "Read before its reset", and a time ahead of the clock reads as age unknown. The card says how old the reading is and what blocks a new one.
- I made a Google hold release when its recorded process number now belongs to a younger process, which proves the number was reused. A hold the proof cannot release names the restart that frees it, and Recover is offered for it.
- I made Settings read the writing rules, the design system and the other reads without a revision while another command is pending, so those rows no longer show "Wait for the pending desktop command."
- I added Refresh models to the Google card. It reads the model list from Ready, keeps Ready while it runs and keeps the earlier list when it fails. The desktop waits for it as long as for a discover. The CLI gains `native setup recover` and `native setup refresh`.
- I kept a thread's hold on a provider process across a reboot. A clock comparison cannot prove a process ended, and its number may belong to another program by now. The hold stays until a check finds the group gone, and a restart keeps the thread's queue held until then. Other threads keep working.
- I rewrote the hold lines so they never ask you to quit a process by number. They say CrewKite cannot confirm the process ended, that other threads still work, and where to export diagnostics.
- I made the Anthropic card read signed out when the client reports that it is not logged in, with the `claude auth login` step. I do not compare the reported expiry time with the clock yet, because I have not captured how the client reports and renews it.
- I made an Anthropic turn stop before its first request when the client reports an API key source, as the OpenAI route already did.
- I made handoff rank each family on the model it will run: the thread's last model on that family, then the Settings choice, then the catalog default. Another model's window no longer drops or reorders a family.
- I made the line after a turn that used up a family's included allowance, with credit spending off, say that the allowance was reached and the next turn moves. No adapter reports a charge, so the line no longer claims credits were spent.
- I made a send that opens no turn say why. The controller answers started, handed on or refused, print mode exits 2 on a refusal without waiting for a turn, and an unknown option with `--json` prints a JSON error line. CLI JSON lines move to version 10. A send refused because credit spending is off no longer saves its message, so sending it again stores it once.
- I made a project check that changes files in the thread's copy fail whatever its exit code, and name the files. They stay in place for review.
- Accept, Discard and the hunk commands now refuse while a check runs in the copy or waits on its question.
- An approval now reads the copy again when it is answered. A command or script that changed in between runs nothing and asks again.
- I made a check whose process CrewKite cannot confirm ended read as unknown. It never counts as a pass and it holds the thread. A check or task command that never started a process fails and holds nothing.
- I made each adapter end a turn as done only on the success its client documents. A known output or step limit fails as incomplete, a stop, refusal or reported error keeps its own kind, and any other status fails once as completion unknown. The files stay, and nothing retries, hands off or moves the crew or plan on. `pnpm protocol:check` flags a client build whose turn statuses or error subtypes differ from the ones CrewKite reads.
- Recovery now removes the folders that Google quota reads leave in the home, in batches of 32, once no Google operation can own one. A folder that is a link, is not mine or is open to other users stays.
- I made the desktop refuse to attach to a controller of another version that still runs on the same home. It says which side is older, starts nothing and signals nothing. After an upgrade the line reads "An older CrewKite is still running with this home. Quit it from its menu, then open CrewKite again." The CLI runs the same check before it sends its token and refuses with the same lines.
- I made a second launch on the same profile say why it quits. It reads the controller record in the home and shows a dialog: the older-controller sentence, or "CrewKite is already open with this profile. Use the window that is open." A startup that fails before any window opens shows its reason in a dialog too.
- I made client discovery run the newest trusted copy of each client. It looks on the search path, in the provider's desktop app and in CrewKite's own folder, and every copy passes the same trust checks. A new major build is accepted, and only a build older than the minimum is refused. On Check again CrewKite fetches a newer OpenAI or Anthropic client into its own folder when the vendor publishes one, after its checksum and Developer ID signature match, on macOS on Apple silicon. It never changes a client you installed and keeps the earlier fetched copy to fall back to. A fetched build that fails its connect-time reads is not used. The Google chat route runs the newest Google agent that carries Google's signature, on the device or fetched on Check again from Google's download host, and keeps the 1.4.0 agent as the fallback ([Proposed ADR 0061](docs/adr/0061-run-the-newest-verified-client-copy.md)).
- I removed the 500 ms wait between the Local connect command and its first read on launch. The controller logs a timing line for the connect command, each probe and the discovery read, so one reopen shows where the time goes.
- [Providers](docs/providers.md) now lists the tested, minimum and pinned build of each client and the platforms it supports. A test keeps the table equal to the versions the code checks.
- I moved the database to schema 27. Schema 22 records how each Google metadata operation settled, and a boot and machine digest taken before each launch. Nothing compares the digests yet. Schema 23 adds the tables for writing rules, dependency preparation, Accept attempts, API connections, the design system, repository policies and GitHub writes. Schema 24 adds the design preview and schema 25 the process group of a GitHub write. Schema 26 adds recipes, their loops, their runs and the result of each plan step. Schema 27 adds one index on chat turns by provider and end time, for the check that a step's allowance reading is its own. Version 0.1.0 refuses an upgraded home with "The database needs a newer controller." and changes nothing.

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
- I versioned the `--json` lines with the thread, turn and event shapes they embed. The line version in this round was `v: 6`, and [the CLI guide](apps/cli/README.md) names the current one.
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
- I drew a dropdown's list inside the dialog that holds it, so the Edit crew lists show above the dialog and reach assistive technology. Escape closes the list and leaves the dialog open.
- I made a full Anthropic usage read retire a window it no longer reports, so a plan with no five-hour limit shows no five-hour bar from an older turn reading, also after a restart.
- I made the Run tests line name the command that failed and its exit status when a project has several test commands, with how many of them failed.
