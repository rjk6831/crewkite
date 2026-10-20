# Local distribution

The local package keeps Electron and the controller's Node runtime separate, as [ADR 0003](adr/0003-typescript-electron-node-controller.md) requires. This is a macOS arm64 directory package. It carries a complete Electron distribution and a pinned Node 24.22.0 binary. The declared binary floor is macOS 13.5. The pinned Node executable requires 13.5; the copied Electron payload requires 13.0. Those load-command values establish a build floor. Runtime compatibility on 13.5 remains unqualified. Developer ID signing, notarization and a general installer remain later distribution work.

This staging path is a local maintainer workflow. It expects the existing checked dependency installation, installed Electron payload and repository-local Node binary under `internal/tools/node-v24.22.0-darwin-arm64/`. A delivered package carries those runtime files. Trying it needs local Git and an existing configured Git identity for branch acceptance.

From the primary checkout, run the staging script with the repository's pinned Node and a new build name:

```sh
internal/tools/node-v24.22.0-darwin-arm64/bin/node scripts/package.mjs --id local-check
```

The default package opens a workspace without a synthetic project or scripted route catalog. Add `--demo` to the staging command to select the demo bootstrap. The runtime manifest records that choice. Existing initialized homes keep their retained data.

The script builds committed source in a disposable copy under `internal/package-build/`. It copies the existing checked dependency installation, requires the same source lockfile and verifies exact direct package identities. Relative workspace links resolve into the disposable copy. It runs no installer or dependency lifecycle scripts and downloads nothing. The final directory under `internal/packages/d0/` contains the complete installed Electron app, built desktop assets, a separate pinned Node binary, runtime source packages, migrations and their dependency closure. Existing output is never replaced. An overlong controller socket path is rejected before copying or building.

Runtime TypeScript lives outside `node_modules`. Relative workspace links point into that runtime, and the script rejects links or entrypoints that resolve outside the package. It includes Zod's JavaScript package and keeps the source layout needed by workers and migrations. The Local SDK uses a private dependency realm under `node_modules/.runtime/`, keeping its Zod 3 dependency separate from the application's Zod 4. Packaging checks the exact twelve-package closure and copies each license text. Local Git remains a prerequisite.

`manifest.json` records source revision, runtime identity, files, checksums and notices. Before inventorying files, the builder applies an ad-hoc resource seal to the staged Electron app with the system `codesign` tool. Runtime signing identifiers can change during sealing. The checked runtime has no entitlement dictionaries before or after sealing. It requires deep, strict signature verification to pass. Either command failing or exceeding thirty seconds blocks staging. The inventory hashes the sealed bytes. The manifest records this ad-hoc seal separately from Developer ID signing and notarization, which remain absent. An ad-hoc seal can pass strict integrity verification while Gatekeeper still rejects the downloaded app. I record browser-download first launch separately, including any explicit trust step scoped to the verified candidate folder. The runtime still carries Electron's license and component notices. The script requires the fixed controller entrypoint, both demo bootstrap files and a nonempty CommonJS preload from the desktop build. A static stage does not establish a working desktop or CLI journey. [ADR 0012](adr/0012-milestones-d0-to-d3.md) requires the packaged fake-provider journey for D0.

The build compiles the committed Local input helper with the installed Command Line Tools compiler and macOS 26.5 SDK, targeting arm64 and macOS 13.5. Missing tools block staging. The compiler has a thirty-second limit and bounded diagnostic output. Packaging never runs the helper. Each package builds the helper from its committed source. The fixed `runtime/bin/local-secure-input` artifact carries its source and executable hashes in the runtime manifest; the package record also retains the compiler hash and SDK settings hash. End users need no compiler.

The package records compiler source and output arguments relative to the build source. Compiler and SDK identities remain hash-pinned. The public manifest contains no absolute build-checkout path.

The controller resolves Local credential input from that fixed runtime manifest. It verifies the packaged Node, helper and native source hashes before supplying the capability. Linked, shared or changed files refuse. A source-only launch without the manifest has no Local credential-input capability. Native prompt behavior and its package launch remain separate checks; the manifest establishes no model qualification.

The first directory layout resolves its trusted runtime from `app.getAppPath()/runtime`. A later branded app needs an explicit resource layout. Runtime selection never comes from page content or a fallback to an arbitrary Node on PATH.

`bin/crewkite` selects the bundled Node and CLI. `bin/desktop` selects the copied Electron app. Its manifest selects the normal controller entrypoint or the explicit demo bootstrap. Both use the package's `state/home`, and the desktop uses a separate `state/profile`. From the primary checkout, use the new stage:

```sh
internal/packages/d0/local-check/bin/desktop
internal/packages/d0/local-check/bin/crewkite task list --json
```

Use the CLI in another terminal while the desktop is open. Its launcher selects the same home; no parent-shell environment change is needed. A package carries Node and Electron, so trying the staged runtime needs no developer rebuild or runtime download. Launcher presence alone is not qualification.

## Candidate identity and user acceptance

I keep each candidate tied to its committed source revision, runtime manifest and exact verification receipt. I stage the normal workspace for real-project user acceptance; a demo payload cannot supply that evidence. Provider clients, account setup and any Local model remain separate prerequisites. Opening the app starts no model task or discovery operation.

A compiled helper, a successful build and a launcher are separate facts from installed recovery or route qualification. I record those outcomes for the exact candidate before claiming them. D2's real-task evidence and user acceptance remain governed by the [roadmap](roadmap.md). Developer ID signing, notarization and general distribution belong to D3 after that gate and my explicit approval.

## Notices and recovery

The package carries the full Node license, Electron license, Chromium component inventory and the licenses for its emitted JavaScript, icons and fonts. It also includes CrewKite's license, notice and [source credits](credits.md). The emitted file inventory is the distribution record; a source-only dependency list cannot establish that closure.

Package output, demo state and desktop profiles stay under `internal/`. Stable and candidate builds use separate homes. The local proof relocates a fresh payload before its first launch, then keeps the selected home and profile fixed through retained-task restart. Registered project, scratch and artifact paths are absolute. Moving an initialized database to a different home remains unqualified.

The proof makes only its disposable build source unavailable. It preserves the primary checkout, installed dependencies and every worktree. Final test payloads start without initialized state; the exercised proof home and its ledger remain separate. Fixture observations intentionally age after five minutes. The source run instructions describe the explicit named-route option for idle demos.

Each delivered payload needs its own runtime, task, restart and export receipt. The local directory proof does not qualify a branded application bundle, Developer ID signing, notarization, Gatekeeper behavior, general installation or the full promotion and rollback process in [ADR 0014](adr/0014-stable-build-controls-candidate.md).


## Downloaded first launch

Check the archive against the release's `SHA256SUMS` before extracting or trusting it. The ad-hoc resource seal checks integrity. It supplies no Developer ID identity, notarization or automatic Gatekeeper acceptance. Opening the runtime directly can show Electron's welcome screen; use `CrewKite.command` to open the workspace.

For the checksum-verified `d2b-uat-01` folder in Downloads, the explicit folder trust step is:

```sh
(
  set -e
  set -C
  /usr/bin/xattr -l -r -s -x "$HOME/Downloads/d2b-uat-01" > "$HOME/Downloads/d2b-uat-01.quarantine-before.txt"
  /usr/bin/xattr -d -r -s com.apple.quarantine "$HOME/Downloads/d2b-uat-01"
)
```

For a new workspace, open the application launcher afterward:

```sh
open "$HOME/Downloads/d2b-uat-01/CrewKite.command"
```

For an existing workspace, keep the fresh replacement unopened and follow the upgrade procedure below.

Use that exact folder only. If the extracted folder has another name or location, stop and use the matching release instructions. Keep the quarantine record alongside the archive. This step removes only download quarantine on that candidate and its contained entries. It changes no global security setting. A checksum mismatch or failed strict signature check needs a corrected package; removing quarantine cannot repair changed bytes. Browser-download cold launch and same-home reopen still need evidence for the exact release.

## Upgrade an existing directory package

Keep the existing app and controller closed until the upgrade finishes. Trust the verified fresh replacement folder before running its upgrade launcher:

```sh
open "$HOME/Downloads/d2b-uat-01/Upgrade Existing.command"
```

Do not open the fresh replacement's `CrewKite.command` first. Choose the existing package folder in the picker. The confirmation shows the exact installed path and unique backup path before any copy or rename. Cancel leaves both packages unchanged.

The helper checks the replacement's complete payload inventory and runtime seal, file ownership and contained links. The existing package's non-runtime files must still match its manifest. Existing changes inside `Electron.app` are allowed because the earlier preview may have been re-signed locally. Its actual runtime bytes are inventoried and retained in the backup, and the confirmation and result explicitly report that difference. The helper never executes the old runtime. Its actual complete payload must remain unchanged through preparation. This exception supplies no publisher identity and does not apply to the replacement package. It refuses active files, a remaining desktop profile lock, an unavailable controller ownership lease, non-private state directories, changed state and an occupied destination. It copies into a new sibling folder and verifies the closed state before moving anything. It records only identity, counts and a state digest; it prints no configuration or credential contents. The copy is limited to 100,000 entries, eight GiB and two minutes per inventory pass. A limit refusal leaves the existing package in place.

The old folder moves to the displayed backup, then the prepared replacement takes its exact original path. `state/home` and `state/profile` keep their original absolute paths. Pending desktop receipt names, Local configuration and retained source paths are preserved. Local tokens held only in controller memory must be entered again after restart. The fresh replacement download remains available. Nothing launches automatically.

If the second rename fails, the helper restores the old folder when the original path is still vacant. It never overwrites a folder that appeared during the swap. Keep every named staging and backup folder after a failure. A crash between renames can require manual restoration. The activity checks do not contain a concurrent launch; keep the old app closed throughout.

The backup preserves the old installation's bytes at a different path. Do not launch it there. To roll back, close the upgraded app, preserve its whole folder at another unused path, and restore the whole original backup to the original installed path. Runtime migrations after upgrade and rollback across changed schemas need separate qualification. Copying an initialized `state` folder into another candidate path remains unsupported.
