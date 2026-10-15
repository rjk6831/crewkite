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
