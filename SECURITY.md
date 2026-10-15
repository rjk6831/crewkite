# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repository's Security tab. I aim to acknowledge reports within a week.

## What CrewKite protects

- Provider credentials stay with the official clients. CrewKite never reads, stores or forwards them.
- Writers work in scratch copies. The user's checkout, Git metadata and remotes stay untouched.
- The control socket accepts only authenticated clients of the same version. Workers never receive its address or token.
- Provider output renders as inert text in a sandboxed, context-isolated renderer.
- Evidence binds to exact content hashes, so changed content cannot inherit an earlier pass.

## What it does not claim

- Containment of a compromised official client. The first release trusts each client's own permission system, as described in [ADR 0009](docs/adr/0009-native-client-trust-profile.md).
- Protection against malware running as the same user.
- Safety guarantees for routes that have not passed qualification. Unqualified routes stay disabled.
