# 0024. Integrate Google through its published ACP agent

- Status: Proposed
- Date: 2026-10-17

## Context

Earlier Google consumer CLI pilots produced retained edits and process evidence. Google's published integration policy excludes wrapping that headless CLI in a third-party coding application. A working pilot could not settle that separate constraint. Google also publishes an ACP agent and documents personal-plan authentication for editors. CrewKite is not named. The [provider notes](../providers.md#google-acp-writer) retain the sources, exact label and client boundaries.

## Decision

I propose a separate `google-acp-v1` profile with CrewKite as the protocol client. I keep the consumer `google-file-v1` writer blocked. The native workspace connector remains context-only; it supplies no writer or Stop authority.

I pin the executable and signer through explicit import. Setup actions have separate bounded ownership; authentication stays with the native agent. Safe proof contains no credentials or OAuth URL. Preparation freezes the client, source and configuration. A fresh session must acknowledge those choices before one prompt.

I limit the writer to one existing file within 64 KiB in independent scratch. Each supported permission needs a current human decision on a complete action within 4 KiB, bound to the exact session, tool call and offered `allow_once`. I bind a bounded hunk to the complete before and after file hashes and require one exact match. Unknown actions refuse. Production review-mode and edit-tool mappings bind the exact imported server, helper, signer and version. Import and discovery alone grant no edit authority.

I require the original cancelled response, closed streams and absent owned group before claiming stopped completion. EOF alone leaves ownership unknown. Capture validates actual bytes and unchanged siblings. Checks, native review and acceptance keep separate authority. Autopilot, automatic handoff and repository-wide editing stay outside this profile.

The quota read is on by default when the pinned client is present. There is no opt-in.

The quota reader shares a durable gate with setup and task admission. Controller startup attempts one read. An authenticated client connection or admission can request a needed refresh. While a client remains authenticated, the controller checks every ten seconds and permits an interval attempt at least 270 seconds after the prior attempt. Startup and connection attempts keep a sixty-second cooldown. Failed reads count toward both limits, and active or unknown Google ownership refuses another read. Fresh exhausted quota refuses an admission refresh. Admission rechecks every bucket, reserve and current authority. Account matching remains user-attested; context tokens supply no account allowance.

## Why

I ruled out using pilot success to infer provider permission. Keeping that distinction meant retiring a working consumer launch path while preserving its historical evidence.

I read the FAQ's headless restriction as aimed at agents that spend the subscription through the CLI. A validated `/usage` response reports `num_turns: 0`, with no generation or account switch. I treat it as a status check that spends no model allowance, so it runs without asking.

I refresh connected dashboards before the five-minute freshness limit, leaving room for bounded metadata cleanup. The reads still cost client and network work. The interval floor and ownership gate limit that traffic; a failed or delayed read leaves the old timestamp visible.

I chose the published protocol because session and permission identities give the controller concrete facts to bind before an effect. An edited file or a quiet process is weaker evidence than the original terminal response plus owned cleanup. I keep missing terminal proof unknown through restart. After a restart, I allow an explicit Stop to release the home's Google gate when the controller holds no runtime for the attempt, no phase remains at launch intent and every recorded process group is absent. The attempt keeps its unknown outcome and retained evidence. Nothing is captured, and the run cannot submit again.

This costs another identity pin, explicit setup and review of each supported client mapping. I accept that cost. Guessing a tool name or review mode would let an unverified provider message decide what a human approved. Conservatively applying every observed quota bucket can also refuse a model because another pool is low; I cannot infer model entitlement from a bucket name.

## Consequences

I keep provider-policy assessment and technical client qualification in release engineering. Product acceptance exercises the workflow, controls and retained results.

- This proposal awaits my acceptance. Accepted ADRs 0005, 0009 and 0012 remain unchanged.
- Offline protocol and controller fixtures establish mechanics only.
- A changed client or account invalidates affected evidence. Earlier CLI pilots and context-only exchanges grant no automatic launch authority.
