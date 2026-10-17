# 0023. Qualify provider eligibility before release

- Status: Proposed
- Date: 2026-10-17

## Context

ADR 0012 names Local, OpenAI, Anthropic and Google in D2. ADR 0005 requires supported official interfaces within each provider's terms. Google consumer CLI wrapping is currently unavailable under its published integration policy. Google also publishes a separate ACP agent for editor hosts. CrewKite is not named in that guidance. Prior pilot results establish process behavior, not present integration permission. The [provider boundaries](../providers.md#current-availability) record that distinction.

## Decision

I propose to retain all four D2 families and qualify each integration's eligibility, authentication and billing path. [Proposed ADR 0024](0024-integrate-google-through-its-published-acp-agent.md) describes the separate ACP route for Google with explicit human approvals and its own quota read. The consumer headless writer stays blocked. The editor precedent leaves CrewKite's orchestrator eligibility unresolved. Installing an official client or recording a user attestation does not satisfy those gates by itself.

D2 still requires ten real tasks from my backlog, durable handoff, honest usage, finite review, two coding slices with a combined check and safe self-development. Provider eligibility does not lower those exits. Real-work user acceptance and final testing follow in D2b. Required corrections must pass verification, and I must explicitly approve starting D3.

## Why

I want provider coverage to follow a specific interface with stated limits and evidence. The published ACP route gives Google a separate path to evaluate while keeping the headless restriction visible. D2 remains blocked until the required routes meet their gates.

## Consequences

- This proposal awaits my acceptance. Accepted ADRs 0005 and 0012 remain unchanged.
- Google remains in the D2 target. This proposal establishes no ACP availability, Local qualification or D2 completion.
- A newly eligible provider needs its own bounded evidence. Earlier pilots grant no automatic admission, credential access or paid fallback.
