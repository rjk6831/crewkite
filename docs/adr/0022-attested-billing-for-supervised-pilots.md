# 0022. Separate observed billing facts from supervised pilot attestations

- Status: Proposed
- Date: 2026-10-17

## Context

ADR 0005 blocks unknown billing. ADR 0009 requires account and billing identity evidence for a native pilot. An official client can report a subscription login method without exposing the plan, request charge or an enforceable spending cap. The current supervised single-file pilot retains explicit subscription and paid-extra-usage confirmations alongside those limited observations.

## Decision

I propose an explicit, profile-specific ordinary-subscription premise for bounded supervised single-file pilots. Each profile must declare its required client observations and user assertions. Retained evidence records their sources separately.

Preparation binds subscription-login and disabled-paid-extra-usage assertions to the exact executable digest, native account location, source, task and policy. Missing required evidence or contradictory observations block launch. The frozen task and time limits still apply. API overrides, paid extra usage and automatic paid API fallback remain forbidden. Existing-credit opt-in remains a separate policy under ADR 0005.

The Anthropic pilot observes the native client's subscription-login marker before submission. That establishes the reported login method. Plan, entitlement, request charges and hard-cap enforcement remain unknown. Google needs its own declared observations; a generic attestation establishes no provider qualification.

## Why

I want a bounded pilot to state the premise it relies on. Treating a login marker as proof of a plan or charge would hide the remaining uncertainty. Explicit assertions make that uncertainty visible and keep authority bound to one preparation.

## Consequences

- This clarification awaits my acceptance. It does not amend Accepted ADRs 0005 or 0009 while Proposed.
- Pilot evidence retains its observed and user-attested provenance. A client, account location, source, task or policy change requires matching authority again.
- Generic automatic routing remains unqualified. No attestation creates an observed billing fact or provider-enforced cap.
