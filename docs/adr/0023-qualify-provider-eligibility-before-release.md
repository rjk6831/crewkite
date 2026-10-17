# 0023. Qualify provider eligibility before release

- Status: Proposed
- Date: 2026-10-17

## Context

ADR 0012 names Local, OpenAI, Anthropic and Google in D2. ADR 0005 requires supported official interfaces within each provider's terms. Google consumer CLI wrapping is currently unavailable under its published integration policy. Prior pilot results establish process behavior, not present integration permission. The [provider boundaries](../providers.md#current-availability) record that distinction.

## Decision

I propose to make D2 provider coverage conditional on a documented permitted integration and its qualified authentication and billing path. The current plan covers qualified OpenAI and Anthropic native routes and a qualified Local route. Google can join a later plan when a documented permitted integration meets the same gates. Installing an official client or recording a user attestation does not satisfy those gates by itself.

D2 still requires ten real tasks from my backlog, durable handoff, honest usage, finite review, two coding slices with a combined check and safe self-development. Provider eligibility does not lower those exits. Real-work user acceptance and final testing follow in D2b. Required corrections must pass verification, and I must explicitly approve starting D3.

## Why

I want the release plan to follow the interfaces I can responsibly support. Keeping an unavailable consumer path in the required roster would obscure the actual blocker and the work still needed for a useful release.

## Consequences

- This proposal awaits my acceptance. Accepted ADRs 0005 and 0012 remain unchanged.
- The roadmap shows the current eligible-provider plan. No D2 completion or Local qualification is claimed.
- A newly eligible provider needs its own bounded evidence. Earlier pilots grant no automatic admission, credential access or paid fallback.
