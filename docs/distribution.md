# Local distribution

The local package keeps Electron and the controller's Node runtime separate, as [ADR 0003](adr/0003-typescript-electron-node-controller.md) requires. This is a macOS arm64 directory package. Signing, notarization and a general installer remain later distribution work.

Run the staging script with the repository's pinned Node and a new build name:

```sh
internal/tools/node-v24.22.0-darwin-arm64/bin/node scripts/package.mjs --id local-check
```

The script builds committed source in a disposable copy under `internal/package-build/`. It copies the existing checked dependency installation, requires the same source lockfile and verifies exact direct package identities. Relative workspace links resolve into the disposable copy. It runs no installer or dependency lifecycle scripts and downloads nothing. The final directory under `internal/packages/d0/` contains the complete installed Electron app, built desktop assets, a separate pinned Node binary, runtime source packages, migrations and their dependency closure. Existing output is never replaced.

Runtime TypeScript lives outside `node_modules`. Relative workspace links point into that runtime, and the script rejects links or entrypoints that resolve outside the package. It includes Zod's JavaScript package and keeps the source layout needed by workers and migrations. Local Git remains a prerequisite.

`manifest.json` records source revision, runtime identity, files, checksums and notices. A static stage does not establish a working desktop or CLI journey. The desktop bridge and packaged bootstrap must be integrated before that claim. [ADR 0012](adr/0012-milestones-d0-to-d3.md) requires the packaged fake-provider journey for D0.

The first directory layout resolves its trusted runtime from `app.getAppPath()/runtime`. A later branded app needs an explicit resource layout. Runtime selection never comes from page content or a fallback to an arbitrary Node on PATH.

`bin/crewkite` selects the bundled Node and CLI. `bin/desktop` selects the copied Electron app and fixed demo bootstrap; it refuses a stage without that entry. Both use the package's `state/home`, and the desktop uses a separate `state/profile`. These launchers do not establish a qualified journey by their presence.

## Notices and recovery

The package carries the full Node license, Electron license, Chromium component inventory and the licenses for its emitted JavaScript, icons and fonts. It also includes CrewKite's license, notice and [source credits](credits.md). The emitted file inventory is the distribution record; a source-only dependency list cannot establish that closure.

Package output, demo state and desktop profiles stay under `internal/`. Stable and candidate builds use separate homes. A relocation check may make the disposable build copy unavailable. It never moves the primary checkout or another worktree. Installed recovery remains unqualified until the staged build passes that check and the retained-task journey in [ADR 0014](adr/0014-stable-build-controls-candidate.md).
