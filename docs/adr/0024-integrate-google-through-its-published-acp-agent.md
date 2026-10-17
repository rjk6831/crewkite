# 0024. Integrate Google through its published ACP agent

- Status: Proposed
- Date: 2026-10-17

## Context

Google excludes consumer headless coding wrappers from its published integration policy. It also publishes an ACP agent and documents personal-plan authentication for editor hosts. CrewKite is not named. The current native workspace connector shares context with a separate interface; it gives CrewKite no writer or Stop authority. The [provider notes](../providers.md#google-acp-writer) record the sources and remaining eligibility question.

## Decision

I propose a separate `google-acp-v1` route with CrewKite as the ACP client. The existing `google-file-v1` headless writer stays blocked. Guided and balanced authority require a human decision for every native approval request. Autopilot and automatic Google handoff stay outside this proposal.

The implementation imports a staged executable and identity record into private, digest-addressed storage. It verifies the managed copy against its macOS Developer ID requirement before publishing an immutable pin. A conflicting pin refuses. Separate setup actions initialize the agent, authenticate through its native personal-account flow and discover session choices without sending a task prompt. CrewKite retains safe proof and a result code, with no credentials or OAuth URL. Preparation freezes the model, optional thought level, client identity, source and policy. A fresh writer session must acknowledge those choices before one bounded prompt.

The first writer is limited to one selected file in independent scratch, within 64 KiB. Its production review-mode and edit-tool mapping tables are empty; launch remains unavailable until the exact pinned client has separately reviewed mapping evidence. Neither import nor discovery can enable it. A permission request must contain one complete target-replacement action within 4 KiB, bound by hash to a current human approval and one offered `allow_once` option. Unknown actions and oversized details refuse without truncation.

The read-only task context stays in private connector storage outside editable scratch and validates the current attempt through approval transitions. A completed writer must prove owned cleanup, validate the target and unchanged siblings, then capture actual bytes. Stop requires the original prompt's cancelled response before closed streams and group absence can establish stopped completion. Missing terminal proof remains unknown. Existing checks, review and destination acceptance retain their own authority under ADRs 0008 and 0009. Independent native review requires a separately supported OpenAI profile, scoped consent and remaining allowance.

The separate opt-in CLI quota read preserves the headless-policy notice. Its controller and interface support do not establish live qualification. A durable metadata-operation gate prevents concurrent quota, ACP setup and native Google work in that controller home. Every unfinished metadata operation remains unknown across restart, without probing or signalling historical processes. Quota reads have a sixty-second cooldown even after failure. Disabling consent revokes in-flight read authority; late results cannot update observations. There is no timer refresh.

ACP preparation requires user-attested confirmation that the quota reader and ACP sign-in use the same Google account, plus the profile's ordinary-subscription and disabled-overage assertions. These remain assertions under Proposed ADR 0022. Every returned bucket must be fresh and above reserve before Start; disabled reads and stale or missing windows block. Context-token usage supplies no account allowance. Automatic admission refresh remains planned.

## Why

I want one interface for the task, its approvals and retained work. The published agent provides a protocol to evaluate without taking over authentication. Applying every account bucket conservatively can refuse a model because another pool is low. I accept that cost while account and model-group evidence remain limited.

## Consequences

- This proposal awaits acceptance. Accepted ADRs 0005, 0009 and 0012 remain unchanged.
- Editor documentation does not settle CrewKite's eligibility. The interface must state that Google documents editors and does not name CrewKite.
- Offline fixtures precede separately authorized native observations. No binary, authentication, permission coverage, Stop, billing or installed recovery is qualified by this record.
- The second executable needs its own identity pin and requalification after changes. Prior CLI pilots and connector evidence cannot supply that proof.
