# Releases

This page keeps the ledger for each release: the checks it passed, its checksums and what it left unqualified.

`node scripts/release-evidence.mjs --out <file>` writes a JSON manifest for the checked-out build: the commit and whether its tree was clean, package versions, the Node version, the lockfile digest and the migration count. Add `--test-output <file>` with a saved `pnpm test` log and `--artifacts <dir>` to include the test counts and the checksums of the files in that directory.

## Version 0.2.0

Version 0.2.0 is in preparation. It adds recipes, loops and results, a design system per project, checks after each writing turn and at Accept, GitHub writes from the thread and API connections. It also fixes the Google hold that the [Google metadata hold](google-metadata-hold.md) page describes. The [changelog](../CHANGELOG.md) lists every change. No signed DMG, Linux package, checksum or release receipt exists for it yet.

Two parts are in this build and switched off, each behind one controller option that is off in the app. Checklist work for loops is refused at the save and at the run, because its reader goes line by line and does not follow every rule of the markup. Report runs are refused when they run, and a report recipe with a trigger is refused at the save, because Accept is not yet refused on a report thread. The editor shows both choices as not available.

This version moves the database from schema 21 to 27. Before the migration runs, the controller writes a copy of the database at its old version beside it. For a home that 0.1.0 used, that copy is `state.sqlite.before-v21.sqlite` next to `state.sqlite` in the controller's `home` folder. Once 0.2.0 has opened a home, 0.1.0 refuses it with "The database needs a newer controller." and changes nothing. Opening 0.2.0 again is the way forward.

Going back to 0.1.0 means that copy. It holds nothing done under 0.2.0, and I have not qualified that rollback. If you take it, quit CrewKite first. Move `state.sqlite` and any `state.sqlite-wal` and `state.sqlite-shm` beside it out of the folder, then copy the backup in as `state.sqlite`. SQLite can apply a leftover `-wal` file to the old copy.

If 0.1.0 is still running when 0.2.0 opens on the same home, the desktop refuses to attach and says "An older CrewKite is still running with this home. Quit it from its menu, then open CrewKite again." It starts no controller and signals no process, so the home stays at schema 21 until the old app quits. If 0.1.0 crashed and no CrewKite window is open, its controller can still run with no menu to quit from. Logging out or restarting the computer ends it.

A thread can stay held when CrewKite cannot confirm that a process it started has ended, because its number is now in use or it never recorded one. Accept, Discard and Delete stay refused on that thread. Its unaccepted work stays on disk in the thread's scratch copy under the controller's `home` folder, and other threads keep working.

The upgrade evidence so far is offline. A test fills a schema 21 home with the state 0.1.0 writes, upgrades it to schema 27 and checks every unchanged table byte for byte, the settlement each old Google metadata row receives, every new table empty and the copy left at version 21. Another runs the schema check 0.1.0 ships against that upgraded home: it refuses, and no byte, mode or file in the home changes. An installed upgrade from 0.1.0 with same-home reopen on macOS arm64 and on Ubuntu 24.04 x64 and arm64 is not done. The Fedora RPM install with its headless runtime and CLI checks is not done either.

Recovery on the home where the Google hold happened, a live quota read and model refresh there, and the three Anthropic sign-in captures (healthy, expired, and just past the reported expiry) are still open. Until those captures exist, CrewKite does not compare the Anthropic expiry time with the clock. One ordinary reopen with the Local timing lines, a networked `pnpm protocol:check` against the current client builds and the missing-interpreter worker row on Linux CI are also open.

No live run has exercised a recipe saved from a real plan thread, a loop on a real allowance, a loop across an app restart, the Results view against real runs, or a design system with its check on a real project. The GitHub writes, API connections, the OpenAI-compatible Local servers and the feedback issue link have no live check either. Directory-preview import is not part of this release.

## Version 0.1.0 distribution in preparation

The installed release is in preparation. Its fixed state layout follows [Proposed ADR 0041](adr/0041-installed-distribution.md). No signed DMG, browser first-open result or installed Linux launch is qualified by this entry. Final source, artifact checksums and the observed release checks belong here when they exist.

Version 0.1.0 starts fresh installed state. Directory-preview import and installed rollback qualification wait for a later release. AppImages ship only if both architectures pass normal sandboxed launch on Ubuntu 24.04. RPM qualification requires build inspection and Fedora container installation; native Fedora desktop launch remains pending. [Distribution](distribution.md#installed-distribution-in-progress) records the required evidence.

## Earlier prereleases

[D2b UAT 05](https://github.com/rjk6831/crewkite/releases/tag/d2b-uat-05) is the current prerelease. It adds OpenAI Project model and effort selection before planning. Its [required CI](https://github.com/rjk6831/crewkite/actions/runs/39617852147) passed 146 Node claims and one desktop journey.

The 196,439,723-byte ZIP passed cold launch, restart and a UAT 04 upgrade with exact state preservation, backup and reopen. Public anonymous downloads matched all three assets. Human UAT, live account catalog discovery and alternate-model execution remain unqualified for this release. The [release receipt](https://github.com/rjk6831/crewkite/releases/download/d2b-uat-05/release.json) records source `fb735357`, tree `96cd6262`, the archive checksum and qualification limits. The package remains ad-hoc signed and unnotarized.

[D2b UAT 04](https://github.com/rjk6831/crewkite/releases/tag/d2b-uat-04) introduced a manual, trusted native Anthropic `/usage` report to the shared remaining-allowance gauges. Its [required CI](https://github.com/rjk6831/crewkite/actions/runs/39610727447) passed 144 Node claims and one desktop journey.

The 196,430,760-byte ZIP passed cold launch and restart checks. An upgrade from UAT 03 preserved the exact retained state, wrote its backup and reopened successfully. A separate-gauge fixture also passed. Public anonymous downloads matched all three release assets. Human UAT and a live Anthropic usage read remain pending. This exact candidate has an ad-hoc integrity seal and no notarization. The public [release receipt](https://github.com/rjk6831/crewkite/releases/download/d2b-uat-04/release.json) records source `25ccd74`, tree `3ef524c3`, the archive checksum and qualification limits.

[D2b UAT 03](https://github.com/rjk6831/crewkite/releases/tag/d2b-uat-03) introduced direct project task definition, the normal OpenAI Project execution path, simpler provider connection, local hardware facts, provider activity and credit status, project Python checks, and byte-exact GitHub job logs. Its [required CI](https://github.com/rjk6831/crewkite/actions/runs/39600267680) passed 139 Node claims and one desktop journey. The matching package passed its recorded static inventory, GUI, upgrade and retained-log checks. Its public [release receipt](https://github.com/rjk6831/crewkite/releases/download/d2b-uat-03/release.json) preserves the exact evidence and limits.

I completed ten real D2 backlog outcomes through the checked workflow. [D2 UAT 02](https://github.com/rjk6831/crewkite/releases/tag/d2-uat-02) then failed installed user acceptance. Downloaded launch, provider setup and persistent project-selection errors blocked ordinary use. That candidate remains available for issue reproduction.

[D2b UAT 02](https://github.com/rjk6831/crewkite/releases/tag/d2b-uat-02) adds bounded artifact reads and retained activity output to the workspace paging, provider setup and project-selection recovery released in [D2b UAT 01](https://github.com/rjk6831/crewkite/releases/tag/d2b-uat-01). Its [required CI](https://github.com/rjk6831/crewkite/actions/runs/39567783678) passed 111 Node claims and one desktop journey. The matching package passed static inventory, disposable upgrade, cold launch and same-home reopen checks. Public anonymous downloads matched all three release assets. The GitHub CLI download matched the archive; Chrome blocked this candidate before creating a file. Human UAT remains pending. Its public [release receipt](https://github.com/rjk6831/crewkite/releases/download/d2b-uat-02/release.json) records the source, archive checksum and qualification limits.

OpenAI Project is the only Project execution engine in this prerelease. Local, Google and Anthropic Project engines remain in progress. Existing saved file runs and CLI single-file support remain available. The new manual Anthropic reader has no live qualification yet. Its receipt time is local, while the report's observation age and account scope remain unknown. The reader sends no model prompt, enables no paid fallback and does not establish current task admission or exhaustion. The [daily-work plan](daily-work-slices.md) tracks the remaining slices; [D3](roadmap.md) keeps its separate approval gate.

From version 0.1.0 a release tag is the version with a leading v, for example `v0.1.0`. The tag points at the commit whose package.json files carry that version, and the earlier `d2b-uat-NN` tags keep their names.
