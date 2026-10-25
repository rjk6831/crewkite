# Trying the preview

This guide takes about two minutes once the app is open. You need a local Git repository with at least one commit and a signed-in client for one provider.

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

## Walkthrough

1. Connect a provider. Open Settings in the left rail. Each provider has a card with its sign-in or connection state, the models it offers and the allowance it has left. Connect one provider there. [Provider routes](providers.md) lists what each provider needs first.
2. Add a project. Choose Add project in the left rail and select the root of a Git repository.
3. Start a thread. Choose New thread. The composer reads "Ask about this project or describe a change". Pick a provider and model from the menu in the composer, then ask about the project, for example "What does this project do and what would you change first?"
4. Watch it stream. The answer appears as the provider writes it. Each file read or search shows as a tool card, and a Thinking card appears for providers that report their reasoning. Two or more finished reads and searches in a row fold into one line, such as "Read 14 files", that opens into the cards. Choose Stop to end a turn early. A message you send while a turn runs waits under the thread and starts when the turn ends.
5. Ask for a change. A permission request appears in the thread with the exact edit or command. Choose Allow once, Allow for this thread or Deny. The default is to ask every time. The edit lands in a scratch copy of the project, and your checkout is not touched.
6. Open Changes. Choose Open in Changes on the edit's tool card, or toggle the inspector and select Changes. It lists each changed file against the base commit, with the diff one click away.
7. Switch provider mid-thread. Open the provider and model menu, pick a model from another provider and send your next message. The reply runs on the new provider in the same scratch copy, and the turn is labelled with its provider. Each provider keeps one colour and a one-letter mark wherever it is named: O for OpenAI, A for Anthropic, G for Google and L for Local. The new provider starts from your messages, the earlier answers, the list of changed files and the patches that still fit. The menu also offers Continue on another provider, which moves the thread at once and adds a line such as "Continued on Anthropic from OpenAI." The inspector's Thread tab lists each turn under the message it answered. Its handoff setting moves the thread by itself when a provider reaches its limit, to the provider with the most allowance left or to the one whose allowance resets soonest, which spends that allowance before it resets unused.
8. Accept to a branch. In the Changes tab, keep the suggested branch name or type your own. The commit message field starts with the thread title and the first line of the last reply; edit it as you like. Choose Accept to branch. The controller commits the scratch copy's changes on a new local branch in your repository and shows the `git switch` line. Your checkout stays on its current branch, with nothing staged or modified.
9. Push and open a pull request. Choose Push branch. The tab asks once whether to push the branch to origin with your own git credentials, and nothing is sent until you choose Push. The thread notes the push. Choose Open pull request next. With `gh` installed, the pull request opens on GitHub and its link shows in the tab. Without it, the tab copies the compare link for a github.com remote. Below that, the tab shows the branch's newest CI run and checks again every thirty seconds while it stays open. ADR 0037 records why each of these steps waits for your click.
10. Run a crew. Settings > General holds three presets: Solo, Pair and Full crew. Open the inspector's Crew tab, choose Start from preset and pick one, then set the flight mode. Manual runs nothing after a reply. Balanced runs up to three reviews, two fixes and a challenge, and asks before a command outside the read-only set, network access, work outside the scratch copy or a delete. Glide runs the same chain and stops only on a failure or a permission your policy does not cover, and it turns automatic handoff on. The pill beside the model picker shows the mode and opens the Crew tab. Under Thread, Handoff mode picks where the thread continues when a limit is reached: Most allowance left, Resets soonest, Even spend or Local first. Hover each name for its rule. While a reply runs, a queued message shows Send now beside Remove. Send now stops the current reply and starts that message with the work so far. ADR 0038 records the rules.

A turn that a crash leaves open shows as failed, with a plain reason, when the controller restarts. Reopening starts no work beyond the messages you queued, which start once the thread is free.

## Send a short record

Keep a short record of what you asked, which provider answered, any refusal or error line, what Changes showed, and whether the next action was clear. A few sentences is enough. The [roadmap](roadmap.md) lists the open evidence gates.
