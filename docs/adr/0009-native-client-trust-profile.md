# 0009. Trust official clients natively in the first release

- Status: Accepted
- Date: 2026-10-11
- Supersedes: an earlier plan for a mandatory custom sandbox around each client

## Context

The 0.4 design wrapped every official client in a custom macOS sandbox. Building and qualifying that wrapper sat in front of the first useful task.

## Decision

The first release offers an explicit, opt-in native trust profile. The unmodified official client and its own permission system are trusted components. CrewKite adds scratch isolation, policy, activity capture and retention. If a known tool escape appears, the affected profile is disabled.

## Why

The custom sandbox delayed the workflow I need most. Stating the trust boundary plainly is more honest than implying containment I have not proven.

## Consequences

- CrewKite claims no containment of a compromised client or of malware running as the same user.
- Six pilot checks gate the first live route: write boundaries, synthetic secret canaries, approval correlation, retention without a summary, account and billing identity, and recovery from the installed app.
- Stronger containment returns when a requirement needs it, with its own evidence.

## Amendment, 2026-10-31

The chat path accepts a range of client builds. For OpenAI, Anthropic and the Google quota reader, CrewKite finds the installed client the way the profiles do, runs its own `--version` flag in an owned process group with a five-second bound, and accepts a build at or above a minimum for the family and within the major version I tested. A later major version is refused until I test it, because a major release is where the native frames the adapters parse change without notice. An older build or a version CrewKite cannot read is refused with one line that names the minimum or the command to run. The trust checks stay and grow: the resolved real path, a regular file, an owner that is the person or the system, no write access for the group or other users, and a containing folder, both where the file lives and where the search found it, that other users cannot write. Only the exact digest equality is gone from this path. The digest still binds each launch to the bytes CrewKite read the version from.

The single-file and repository writer profiles keep their exact pins and their D1 and D2 qualification evidence. The Google ACP agent keeps its fixed archive and digests, because CrewKite installs that bundle itself.

I made this change because the clients ship several builds a week. An exact pin meant that a person who installed the current client got a build mismatch and could not connect, and that I would ship a release for every client update. The writer profiles are different: their evidence is about one build, and a new build there is a new qualification. The [provider notes](../providers.md#client-versions) name the tested builds and minimums.

