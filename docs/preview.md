# Trying the preview

This guide gives one practical sequence for trying the candidate on a real project. You need a local Git repository and any provider client you plan to use.

## Verify the download

Download the macOS arm64 ZIP and `SHA256SUMS` from the same published [release](https://github.com/rjk6831/crewkite/releases). Read its release receipt for the exact source revision, tested macOS version, signing status and provider qualification.

From the folder holding both downloaded files, run:

```sh
shasum -a 256 -c SHA256SUMS
```

Extract the archive after the checksum passes. Keep its folder together. If macOS blocks opening it, retain the exact message with the candidate identity in your report. The [distribution notes](distribution.md) distinguish directory-package testing from signing and installation checks.

## Open the candidate

The preview has an ad-hoc resource seal. It has no verified Developer ID identity and is not notarized by Apple. Check the release receipt for the exact candidate's first-launch evidence.

Keep the extracted candidate folder together and double-click `CrewKite.command`. It opens the workspace through the adjacent `bin/desktop` launcher. The folder can move before its first launch. After setup, reopen the same folder to retain its projects, tasks and settings. To replace an initialized candidate, use the fresh package's `Upgrade Existing.command` and follow the [state-preserving upgrade procedure](distribution.md#upgrade-an-existing-directory-package). Keep the old app closed. The helper preserves the exact installed path and retains the original folder as a backup; moving its initialized state into another candidate folder is unsupported.

macOS can require separate approval for `CrewKite.command` and `Electron.app`. After each blocked attempt, use System Settings > Privacy & Security > Open Anyway for that exact item. Opening `Electron.app` directly can show its runtime welcome screen. Quit it with Command-Q, then launch `CrewKite.command` again.

The ad-hoc seal does not establish publisher identity, notarization or automatic Gatekeeper acceptance. Download quarantine can remain on an embedded executable after app approval. If the verified candidate still fails to open, retain the exact message and follow its release-specific first-launch instructions. Any folder trust step must name only that checksum-verified candidate and preserve its original quarantine metadata. A damaged-app message alone does not establish whether the bytes changed.

From Terminal, change into that candidate folder and use:

```sh
./bin/desktop
./bin/crewkite task list --json
```

I record the exact source revision, verification and provider qualification in the candidate's release receipt. A working launcher does not establish a qualified provider route. The [distribution notes](distribution.md) describe the directory package and remaining install checks.

## Start a task

These steps describe the next candidate workflow. Do not use them with the latest download until a matching package and release receipt pass the required checks.

1. Open the normal candidate. Packaging details are in the [distribution notes](distribution.md).
2. Choose Connect providers and check the clients you plan to use. Coding setup readiness and quota are separate facts. A connected client does not make every Project engine ready.
3. Choose Add project and select the exact Git repository root. A refused folder reports its reason and permits another selection after its saved command settles.
4. On that project row, choose New task. The project is already selected. Enter a title, outcome and one acceptance criterion per line, then choose Create task. The global New task action opens the same form with a project selector.

## Plan before coding

Plan with AI is optional. If you use it, send a bounded objective, read the answers, criteria and scope, and choose Adopt plan only when they match your intent. Adoption saves the task contract and starts no coding work.

For a normal new task, choose Prepare run. Keep the Project scope and OpenAI Project profile, then select a model and effort from the loaded advertised choices when available. Choose Start task to open the permission draft. Subscription only is the default. Read the exact source and policy, then select “Allow OpenAI to read this project, edit a separate working copy, and run local commands using my signed-in client.” Choose Review task to save that preparation, review it once more, then choose Start task. Work runs in a separate scratch copy.

A material model or effort Save creates a linked planning run and returns the contract to provisional, so adopt a fresh valid plan before preparing execution again. Make material planning changes before execution begins, since that Save is scoped to the discussion. Once an execution run exists, it is retained, and material planning changes are unavailable there. Ordinary messages remain guidance and do not replace that run.

Manual single-file targeting is retained for saved legacy runs but is not the normal entry for a new task. The project check recipe appears only when the source contains the supported recipe files.

## Review the result

Open Changes to inspect the retained work. Checks and review are separate actions with their own permissions. A passing result still needs your approval for that destination before CrewKite creates one new local branch. Nothing merges, checks out, pushes or publishes, and your original checkout stays unchanged.

## Stop and reopen

Use Stop to end active work. Reopening the same home launches nothing. An uncertain command keeps its original receipt, so you can retry that exact command. Unresolved ownership is shown as such and gives no permission to relaunch the work or treat it as complete.

## Providers

Open Connect providers from the workspace sidebar. The same controls appear in Usage and capacity.

- Refresh OpenAI quota reads the supported installed client's existing subscription session. It submits no model prompt. Readiness failures show the retained reason and next action.
- Check Anthropic sign-in observes the supported installed native client. A signed-out client needs its own native sign-in, described in the [provider instructions](providers.md#anthropic-writer-preparation). There is no standalone Anthropic quota gauge; allowance stays unknown until a supported reader or an explicitly started task reports it.
- Connect Google downloads and verifies the reviewed official ACP client when needed, initializes it, pauses for explicit Sign in with Google in the browser, and then discovers choices automatically. You complete and control the Google account sign-in. The separate Google quota gauge does not establish coding readiness.

Local uses a dedicated token by default. Enter the loopback endpoint and choose Connect once. The packaged app saves a changed endpoint, requests the token through its native input, connects and discovers loaded models automatically. It checks status once per second for up to 20 attempts without overlapping requests; use the single Refresh action if it takes longer. Select an observed model to save it immediately. Load or unload models in the Local app. An explicit CLI configuration can instead select no authentication, limited to this device's loopback address. The main interface has no selector and never switches modes automatically. See the [provider notes](providers.md#local-models) and the [CLI guide](../apps/cli/README.md). Model eligibility is not qualification. An eligible model stays unmeasured until separate evidence covers it.

### Use Google for one file

The Google ACP profile can edit one existing committed UTF-8 text file within 64 KiB. A recorded workflow completed checks, separate review, local branch acceptance and same-home reopen. Other advertised models remain subject to their own observed behavior and quota rules; see the [current model boundaries](providers.md#google-acp-writer).

1. Complete the Google setup sequence above and confirm that discovery has returned model choices. A missing client, incomplete sign-in or missing verified permission mapping keeps preparation unavailable.
2. Add the Git project and create a task. If you use planning, review and adopt its file scope before execution. The current primary planning role uses the supported OpenAI profile; Google selection happens during coding preparation.
3. Open execution preparation, choose Native file proposal and select Google ACP single-file proposal. Choose the existing committed target, an advertised Google model and its optional thought level. Set finite limits that leave room for the later check and review.
4. Review the subscription-only and separate quota-account confirmations, native trust and source-sharing permission. Choose Prepare native proposal, inspect the saved source and settings, then Start. Preparation sends no model prompt. Start rechecks the selected configuration and quota.
5. Inspect each pending edit's exact old and new text and approve or deny it. Every edit needs its own human decision. Open Changes after normal completion to inspect the retained candidate.
6. Open Checks and review, select a supported OpenAI reviewer and prepare the separate check and review permissions. Run the supported checks, then start review after they pass. A passing candidate still needs destination-specific approval before Accept candidate creates a new local branch. Quit and reopen the same installed CrewKite folder with its existing home, then inspect the retained task and candidate. Keep the initialized home in place.

Google project commands, repository-wide editing, delegation, lead and orchestrator roles, formal review and automatic handoff are not implemented in this profile. The manual [native workspace connector](providers.md#google-native-workspace-context) shares bounded task context with a separately operated native client and retains unverified output. The [CLI guide](../apps/cli/README.md#google-acp-setup) also documents the explicit setup and single-file task commands.

## Usage and context

Usage shows reported or last-observed values with their source and time. Missing data appears as unknown. CrewKite does not estimate how full a window is from tokens, and it does not infer quota from them. After a successful OpenAI planning turn, the composer can show last-observed context tokens and reported capacity. Without reported capacity, the percentage stays unknown.

## Send a short record

Keep a short record of the concrete result you observed, any refusal, the changes or evidence retained, how Stop and reopen behaved, and whether the next action was clear. A few sentences is enough. The [roadmap](roadmap.md) lists the open evidence gates.
