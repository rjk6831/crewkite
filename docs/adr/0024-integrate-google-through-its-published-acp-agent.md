# 0024. Integrate Google through its published ACP agent

- Status: Proposed
- Date: 2026-10-17

## Context

Google excludes consumer headless coding wrappers from its published integration policy. It also publishes an ACP agent and documents personal-plan authentication for editor hosts. CrewKite is not named. The current native workspace connector shares context with a separate interface; it gives CrewKite no writer or Stop authority. The [provider notes](../providers.md#google-acp-writer) record the sources and remaining eligibility question.

## Decision

I propose a separate `google-acp-v1` route with CrewKite as the ACP client. The existing `google-file-v1` headless writer stays blocked. Guided and balanced authority require a human decision for every native approval request. Autopilot and automatic Google handoff stay outside this proposal.

Explicit setup would initialize the pinned agent, authenticate through its native personal-account flow and discover session choices without sending a task prompt. CrewKite would retain safe proof and a result code, with no credentials or OAuth URL. Preparation would freeze the model, optional thought level, client identity, source and policy. A fresh writer session would have to acknowledge those choices before one bounded prompt.

The first writer would edit one selected file in independent scratch. The controller would prove quiescence, validate the target and unchanged siblings, then capture actual bytes. Existing checks, review and destination acceptance would retain their own authority under ADRs 0008 and 0009.

The separate opt-in CLI quota read preserves the headless-policy notice. Its controller and interface support do not establish live qualification. A durable metadata-operation gate prevents concurrent Google work in that controller home, retains uncertain ownership across restart and applies a sixty-second cooldown even after failure. Disabling consent revokes in-flight authority; late results cannot update observations. There is no timer refresh.

ACP preparation would require user-attested confirmation that the quota reader and ACP login use the same Google account, plus the profile's ordinary-subscription and disabled-overage assertions. These would remain assertions under Proposed ADR 0022. Every returned bucket must be fresh and above reserve before Start; disabled reads and stale or missing windows block. Context-token usage supplies no account allowance. The ACP setup and admission handlers remain planned.

## Why

I want one interface for the task, its approvals and retained work. The published agent provides a protocol to evaluate without taking over authentication. Applying every account bucket conservatively can refuse a model because another pool is low. I accept that cost while account and model-group evidence remain limited.

## Consequences

- This proposal awaits acceptance. Accepted ADRs 0005, 0009 and 0012 remain unchanged.
- Editor documentation does not settle CrewKite's eligibility. The interface must state that Google documents editors and does not name CrewKite.
- Offline fixtures precede separately authorized native observations. No binary, authentication, permission coverage, Stop, billing or installed recovery is qualified by this record.
- The second executable needs its own identity pin and requalification after changes. Prior CLI pilots and connector evidence cannot supply that proof.
