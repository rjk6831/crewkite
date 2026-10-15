# Contributing

CrewKite is early. I review every change myself, and these rules keep the codebase and its history consistent whoever writes the first draft. CI checks most of them.

## Setup

Use Node 24 (see `.nvmrc`) and pnpm. `pnpm install` points git at the hooks in `.githooks`, which check branch names, commit messages and staged paths before anything leaves your machine.

## Branches and pull requests

- Name branches `<type>/<kebab-topic>`, for example `feat/usage-gauges` or `fix/stale-approval`.
- Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.
- Keep one change per pull request. Describe what changed, why, and the evidence that it works.
- Pull requests merge by squash after the `required` check passes. `main` stays linear.

## Commits

- Use Conventional Commits: `feat(router): prefer routes that reset sooner`.
- Keep the subject under 72 characters, lower case after the colon, with no trailing period.
- Use the body to explain why. The diff already shows what.
- Sign off every commit with `git commit -s`. The sign-off certifies the [Developer Certificate of Origin](https://developercertificate.org): you wrote the change or have the right to submit it under the project license.
- Leave out tool authorship trailers and generated-by lines.

## Writing code

Work down this ladder and stop at the first rung that solves the problem:

1. Does this need to exist at all?
2. Does the repository already have a helper or pattern for it?
3. Does the standard library cover it?
4. Does the platform cover it (Node, Electron, the browser, SQLite)?
5. Does an installed dependency cover it?
6. Write the smallest code that works.

The ladder is adapted from [Ponytail](https://github.com/DietrichGebert/ponytail).

Some things never get the short version: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, and anything a decision record requires.

- TypeScript runs in strict mode. Validate data with the shared schemas wherever it crosses a process boundary.
- Add a dependency only with a sentence in the pull request explaining why the ladder stopped there.
- Mark a deliberate shortcut with a `shortcut:` comment that names its limit and the upgrade path.
- Respect the component boundaries in [docs/architecture.md](docs/architecture.md). The renderer never touches the database or launches providers.
- Changes to contracts, migrations, the lockfile or entry points land in their own pull request before the code that depends on them.
- Agent and model product names belong only under a `providers/` directory.

## Tests

Read [docs/testing.md](docs/testing.md) before adding tests. Each test names the claim it protects and runs at the lowest layer that can observe it. `pnpm verify` runs the whole suite and must stay under five minutes.

## Documentation

- Write decision documents (README rationale, ADRs, design pages) in first person. I own these decisions.
- Use plain, direct sentences that start with the verb or the subject. Describe things as they are.
- Skip slogans, taglines and bold lead-ins.
- `scripts/policy.mjs` lists the punctuation and phrasing rules CI enforces on Markdown.
- Record a changed decision as a new ADR or a dated amendment. See [docs/adr/README.md](docs/adr/README.md).

## License

Contributions are accepted under the Apache License 2.0, the same license as the project. See [ADR 0018](docs/adr/0018-apache-2-license.md).

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please do not open public issues for vulnerabilities.
