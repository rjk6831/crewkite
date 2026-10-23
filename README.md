# CrewKite

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="apps/desktop/src/renderer/assets/crewkite-wordmark-inverse.png">
  <img src="apps/desktop/src/renderer/assets/crewkite-wordmark.png" alt="CrewKite" width="320" height="107">
</picture>

CrewKite is a desktop chat for coding on the OpenAI, Anthropic and Google subscriptions you already pay for, and on a local model. A thread can move from one provider to another and keep its messages and its edited files.

CrewKite by Roots No Limits LLC. Created by Raymond J. Kraft.

![The thread view: a streamed reply, a thinking card, tool cards with a diff and an inline permission prompt.](docs/images/thread.png)

## Install

1. Install Node 24.22.0 and pnpm 12.11.2.
2. Run `pnpm install`, then `pnpm desktop:install` to download the Electron binary.
3. Run `pnpm demo` to open the desktop on a synthetic project with scripted providers. To use your own clients on Apple silicon, stage a package with `node scripts/package.mjs --id my-build` and open `bin/desktop` in the folder it prints. The script expects the pinned Node binary under `internal/tools` and a committed working tree.

To try a published build without the source, follow the [preview guide](docs/preview.md). Each provider needs its own client, signed in on your machine. [Provider routes](docs/providers.md) lists the setup for each and which routes have a live run on record.

## Principles

- Qualify official clients on their supported subscription path. Cloud-provider authentication stays with those clients. CrewKite never falls back to paid API billing on its own.
- Report usage as observed. A gauge needs a real denominator, a source and a timestamp. Unknown is a valid state.
- Keep authority in code. Prompts and model output cannot grant permissions, raise limits or accept results.
- Preserve your source. Writers work in scratch copies. Results land as new local branches only.
- Keep the core small. Each new mechanism has to serve an enabled requirement or remove demonstrated work.

## Documentation

- [Preview walkthrough](docs/preview.md)
- [Architecture](docs/architecture.md)
- [Provider routes](docs/providers.md)
- [Usage and routing](docs/routing.md)
- [Continuity and recovery](docs/continuity.md)
- [Testing approach](docs/testing.md)
- [Roadmap](docs/roadmap.md)
- [Releases](docs/releases.md)
- [Design history](docs/history.md)
- [Architecture decision records](docs/adr/README.md)

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request. The [credits and notices](docs/credits.md) record pinned sources and licenses. CrewKite is licensed under the Apache License 2.0. See [LICENSE](LICENSE).
