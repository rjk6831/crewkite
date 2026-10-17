# 0024. Integrate Google through its published ACP agent

- Status: Proposed
- Date: 2026-10-17

## Context

Earlier Google consumer CLI pilots produced retained edits and process evidence. Google's published integration policy excludes wrapping that headless CLI in a third-party coding application. A working pilot could not settle that separate constraint. Google also publishes an ACP agent and documents personal-plan authentication for editors. CrewKite is not named. The [provider notes](../providers.md#google-acp-writer) retain the sources, exact label and unresolved eligibility question.

## Decision

I propose a separate `google-acp-v1` profile with CrewKite as the protocol client. I keep the consumer `google-file-v1` writer blocked. The native workspace connector remains context-only; it supplies no writer or Stop authority.

I pin the executable and signer through explicit import. Setup actions have separate bounded ownership; authentication stays with the native agent. Safe proof contains no credentials or OAuth URL. Preparation freezes the client, source and configuration. A fresh session must acknowledge those choices before one prompt.

I limit the writer to one existing file within 64 KiB in independent scratch. Each supported permission needs a current human decision on a complete action within 4 KiB, bound to the exact session, tool call and offered `allow_once`. Unknown actions refuse. Production review-mode and edit-tool mappings remain empty; import and discovery cannot make the writer available.

I require the original cancelled response, closed streams and absent owned group before claiming stopped completion. EOF alone leaves ownership unknown. Capture validates actual bytes and unchanged siblings. Checks, native review and acceptance keep separate authority. Autopilot, automatic handoff and repository-wide editing stay outside this profile.

The opt-in quota reader shares a durable gate with setup and task admission. Start can request one needed refresh under saved consent, with a finite process bound and failed-read cooldown. Fresh exhausted quota refuses without another read. Admission rechecks every bucket, reserve and current authority. Account matching remains user-attested; context tokens supply no account allowance.

## Why

I ruled out using pilot success to infer provider permission. Keeping that distinction meant retiring a working consumer launch path while preserving its historical evidence.

I chose the published protocol because session and permission identities give the controller concrete facts to bind before an effect. An edited file or a quiet process is weaker evidence than the original terminal response plus owned cleanup. I kept those requirements through Stop and restart, even where that leaves work blocked.

This costs another identity pin, explicit setup and an unavailable writer while mapping evidence is missing. I accept that cost. Guessing a tool name or review mode would let an unverified provider message decide what a human approved. Conservatively applying every observed quota bucket can also refuse a model because another pool is low; I cannot infer model entitlement from a bucket name.

## Consequences

I keep provider-policy assessment and technical client qualification in release engineering. Product acceptance exercises the workflow, controls and retained results.

- This proposal awaits my acceptance. Accepted ADRs 0005, 0009 and 0012 remain unchanged.
- Editor documentation leaves CrewKite's orchestrator eligibility unresolved. The interface keeps that limit visible.
- Offline protocol and controller fixtures establish mechanics only. Exact client, authentication, permission, billing, Stop and installed recovery still need their own qualification.
- A changed client or account invalidates affected evidence. Earlier CLI pilots and context-only exchanges grant no automatic launch authority.
