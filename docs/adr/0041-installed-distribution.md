# 0041. Keep installed application files separate from workspace state

- Status: Proposed
- Date: 2026-11-02

## Context

The directory preview keeps state beside its runtime. An installed macOS app, a Linux system package and a mounted AppImage cannot depend on writable application files. Signing also fixes the bytes of the delivered runtime. [ADR 0003](0003-typescript-electron-node-controller.md) requires a separate pinned Node controller, and [ADR 0014](0014-stable-build-controls-candidate.md) requires recovery without losing later records.

## Decision

I keep the installed payload immutable and give the desktop and CLI one fixed state location:

| Platform | State root |
|----------|------------|
| macOS arm64 | `~/Library/Application Support/CrewKite` |
| Linux x64 and arm64 | `${XDG_DATA_HOME:-~/.local/share}/crewkite` |

Each root contains separate `home` and `profile` directories. A fresh install starts fresh state. Version 0.1.0 does not import an initialized directory preview or qualify rollback. A database with an incompatible schema is refused through a read-only check before any state write.

I keep the existing committed-source staging, dependency closure, notices and contained runtime paths. The app uses its bundled Node, checks its checksum and executed identity, and retains every startup integrity check. The manifest records the final signed bytes. The macOS identity is `com.rootsnolimits.crewkite`, with the CrewKite name and existing kite mark.

I use native platform tools for the DMG, DEB and RPM, with pinned AppImage tools if AppImage qualifies. No JavaScript packaging dependency is added. Signing and notarization run outside CI with locally supplied identity and profile names. Credentials stay outside the source tree and output.

Linux keeps the chat scope in [ADR 0013](0013-macos-first-local-optional.md): OpenAI, Anthropic and Local without token authentication. Google, task writers, formatting and verification remain macOS-only. Windows is unsupported and WSL2 is untested.

## Why

I can replace application files without moving a workspace or writing into a signed bundle. The existing staging code already owns the payload trust checks. Native tools add the required formats without adopting another dependency resolver or application launcher.

I require the Chromium sandbox on Linux. If normal AppImage launch fails its sandbox check on Ubuntu 24.04, I omit both AppImages from 0.1.0. I accept the smaller release surface.

## Consequences

- I require real installed launch evidence on Ubuntu 24.04 x64 and arm64 before releasing the Linux packages.
- RPM build, inspection and a Fedora container install qualify the 0.1.0 RPM artifact. Native Fedora desktop launch remains pending and the release notes say so.
- I claim macOS signing, notarization and first-open behavior only after recording the signature, stapling and browser-download observations for the exact assets.
- Replacing installed files keeps the selected state path. Cross-version recovery and rollback need their own evidence. I never restore an older ledger over later records as part of application replacement.
- This record describes work in progress. A successful stage or fixture test does not establish an installed release.
