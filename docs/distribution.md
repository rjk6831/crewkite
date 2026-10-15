# Local distribution

The local package keeps Electron and the controller's Node runtime separate, as [ADR 0003](adr/0003-typescript-electron-node-controller.md) requires. This is a macOS arm64 directory package. It carries a complete Electron distribution and a pinned Node 24.22.0 binary. Signing, notarization and a general installer remain later distribution work.

This staging path is a local maintainer workflow. It expects the existing checked dependency installation, installed Electron payload and repository-local Node binary under `internal/tools/node-v24.22.0-darwin-arm64/`. A delivered package carries those runtime files. Trying it needs local Git and an existing configured Git identity for branch acceptance.

From the primary checkout, run the staging script with the repository's pinned Node and a new build name:

```sh
internal/tools/node-v24.22.0-darwin-arm64/bin/node scripts/package.mjs --id local-check
```

The script builds committed source in a disposable copy under `internal/package-build/`. It copies the existing checked dependency installation, requires the same source lockfile and verifies exact direct package identities. Relative workspace links resolve into the disposable copy. It runs no installer or dependency lifecycle scripts and downloads nothing. The final directory under `internal/packages/d0/` contains the complete installed Electron app, built desktop assets, a separate pinned Node binary, runtime source packages, migrations and their dependency closure. Existing output is never replaced. An overlong controller socket path is rejected before copying or building.

Runtime TypeScript lives outside `node_modules`. Relative workspace links point into that runtime, and the script rejects links or entrypoints that resolve outside the package. It includes Zod's JavaScript package and keeps the source layout needed by workers and migrations. Local Git remains a prerequisite.

`manifest.json` records source revision, runtime identity, files, checksums and notices. The script requires both fixed bootstrap files and a nonempty CommonJS preload from the desktop build. A static stage does not establish a working desktop or CLI journey. [ADR 0012](adr/0012-milestones-d0-to-d3.md) requires the packaged fake-provider journey for D0.

The first directory layout resolves its trusted runtime from `app.getAppPath()/runtime`. A later branded app needs an explicit resource layout. Runtime selection never comes from page content or a fallback to an arbitrary Node on PATH.

`bin/crewkite` selects the bundled Node and CLI. `bin/desktop` selects the copied Electron app and fixed demo bootstrap. Both use the package's `state/home`, and the desktop uses a separate `state/profile`. From the primary checkout, use the new stage:

```sh
internal/packages/d0/local-check/bin/desktop
internal/packages/d0/local-check/bin/crewkite task list --json
```

Use the CLI in another terminal while the desktop is open. Its launcher selects the same home; no parent-shell environment change is needed. A package carries Node and Electron, so trying the staged runtime needs no developer rebuild or runtime download. Launcher presence alone is not qualification.

## Notices and recovery

The package carries the full Node license, Electron license, Chromium component inventory and the licenses for its emitted JavaScript, icons and fonts. It also includes CrewKite's license, notice and [source credits](credits.md). The emitted file inventory is the distribution record; a source-only dependency list cannot establish that closure.

Package output, demo state and desktop profiles stay under `internal/`. Stable and candidate builds use separate homes. The local proof relocates a fresh payload before its first launch, then keeps the selected home and profile fixed through retained-task restart. Registered project, scratch and artifact paths are absolute. Moving an initialized database to a different home remains unqualified.

The proof makes only its disposable build source unavailable. It preserves the primary checkout, installed dependencies and every worktree. Final test payloads start without initialized state; the exercised proof home and its ledger remain separate. Fixture observations intentionally age after five minutes. The source run instructions describe the explicit named-route option for idle demos.

Each delivered payload needs its own runtime, task, restart and export receipt. The local directory proof does not qualify a branded application bundle, signing, notarization, Gatekeeper behavior, general installation or the full promotion and rollback process in [ADR 0014](adr/0014-stable-build-controls-candidate.md).
