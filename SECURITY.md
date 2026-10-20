# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's "Report a vulnerability" button on this repository's Security tab. I aim to acknowledge reports within a week.

## What CrewKite protects

- Cloud provider credentials stay with the official clients. CrewKite does not extract or read those cloud authentication stores.
- Local server credentials use a separate, explicit path. In authenticated Local mode, a fixed packaged native prompt sends a dedicated Local credential into private controller memory for the authenticated loopback connection. The value is excluded from durable state, logs, saved setup, snapshots and model observations, and restarting CrewKite requires input again. A source-only launch without the fixed packaged helper has no credential-input capability. The decision for this path is Proposed in [ADR 0025](docs/adr/0025-use-an-explicit-memory-only-local-credential.md).
- Explicit no-authentication mode connects to literal loopback on this device and sends no credential. CrewKite may retain a nonsecret confirmation for the same saved configuration. It does not change the server's authentication setting or switch modes after an authentication failure.
- Writers work in scratch copies. The user's checkout, Git metadata and remotes stay untouched.
- The control socket accepts only authenticated clients of the same version. Workers never receive its address or token.
- Provider output renders as inert text in a sandboxed, context-isolated renderer.
- Evidence binds to exact content hashes, so changed content cannot inherit an earlier pass.

## What it does not claim

- Containment of a compromised official client. The first release trusts each client's own permission system, as described in [ADR 0009](docs/adr/0009-native-client-trust-profile.md).
- Protection against malware running as the same user.
- Safety guarantees for routes that have not passed qualification. An available client, configured connection, loaded model or selected route does not establish qualification. Available Local or other supervised native profiles can remain qualification-pending under explicit consent and bounded authority. Unsupported or unsafe routes fail closed, but not every unqualified route is disabled.
