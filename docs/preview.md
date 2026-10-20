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

Keep the extracted candidate folder together and double-click `CrewKite.command`. It opens the workspace through the adjacent `bin/desktop` launcher. The folder can move before its first launch. After setup, reopen the same folder to retain its projects, tasks and settings.

macOS can require separate approval for `CrewKite.command` and `Electron.app`. After each blocked attempt, use System Settings > Privacy & Security > Open Anyway for that exact item. Opening `Electron.app` directly can show its runtime welcome screen. Quit it with Command-Q, then launch `CrewKite.command` again.

The ad-hoc seal does not establish publisher identity, notarization or automatic Gatekeeper acceptance. Download quarantine can remain on an embedded executable after app approval. If the verified candidate still fails to open, retain the exact message and follow its release-specific first-launch instructions. Any folder trust step must name only that checksum-verified candidate and preserve its original quarantine metadata. A damaged-app message alone does not establish whether the bytes changed.

From Terminal, change into that candidate folder and use:

```sh
./bin/desktop
./bin/crewkite task list --json
```

I record the exact source revision, verification and provider qualification in the candidate's release receipt. A working launcher does not establish a qualified provider route. The [distribution notes](distribution.md) describe the directory package and remaining install checks.

## Start a task

1. Open the normal candidate. Packaging details are in the [distribution notes](distribution.md).
2. Choose Add project and select the exact Git repository root.
3. Choose New task, select that project, and read the planning permission before sending anything.
4. Review the explicit provider setup in Usage and capacity. Details are in the [provider routes](providers.md).

## Plan before coding

Planning and coding are separate. Send a bounded objective, then read the answers, criteria and scope. Choose Adopt plan only when they match your intent. Adoption saves the task contract and starts no coding work.

Execution is a second step. Prepare the source, permissions and finite limits, review them, then choose Start.

A material model or effort Save creates a linked planning run and returns the contract to provisional, so adopt a fresh valid plan before preparing execution again. Make material planning changes before execution begins, since that Save is scoped to the discussion. Once an execution run exists, it is retained, and material planning changes are unavailable there. Ordinary messages remain guidance and do not replace that run.

## Review the result

Open Changes to inspect the retained work. Checks and review are separate actions with their own permissions. A passing result still needs your approval for that destination before CrewKite creates one new local branch. Nothing merges, checks out, pushes or publishes, and your original checkout stays unchanged.

## Stop and reopen

Use Stop to end active work. Reopening the same home launches nothing. An uncertain command keeps its original receipt, so you can retry that exact command. Unresolved ownership is shown as such and gives no permission to relaunch the work or treat it as complete.

## Providers

Local uses a dedicated token by default. The packaged app asks for it and keeps it in controller memory, so it is requested again after a restart. An explicit CLI configuration can instead select no authentication, limited to this device's loopback address. The main interface has no selector and never switches modes automatically. See the [provider notes](providers.md#local-models) and the [CLI guide](../apps/cli/README.md). Model eligibility is not qualification. An eligible model stays unmeasured until separate evidence covers it.

## Usage and context

Usage shows reported or last-observed values with their source and time. Missing data appears as unknown. CrewKite does not estimate how full a window is from tokens, and it does not infer quota from them. After a successful OpenAI planning turn, the composer can show last-observed context tokens and reported capacity. Without reported capacity, the percentage stays unknown.

## Send a short record

Keep a short record of the concrete result you observed, any refusal, the changes or evidence retained, how Stop and reopen behaved, and whether the next action was clear. A few sentences is enough. The [roadmap](roadmap.md) lists the open evidence gates.
