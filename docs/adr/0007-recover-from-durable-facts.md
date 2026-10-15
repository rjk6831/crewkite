# 0007. Recover tasks from durable facts, without a final model summary

- Status: Accepted
- Date: 2026-10-06, scope clarified 2026-10-12

## Context

When a provider hits a hard limit or crashes, asking it for a handoff summary is the step that fails. I lose time rebuilding context for the next tool. Other projects already ship context summaries and native session resume, so a summary alone adds nothing new.

## Decision

The controller records task facts and received artifacts before they are needed for recovery. At verified boundaries it seals a versioned, checksummed handoff packet. A successor route starts from that packet and the referenced files. Manual route switching ships before automatic failover. [Continuity and recovery](../continuity.md) defines the packet and the transfer sequence.

## Why

The facts that matter (criteria, decisions, denials, files, failed checks, remaining budget) already pass through the controller. Persisting them makes recovery independent of any one model's cooperation.

## Consequences

- Transfer waits until the old writer is proven stopped. Unknown ownership blocks it.
- Partial files survive and stay marked unverified.
- Pins, denials and budgets carry across a handoff. A provider limit never authorizes a new account, a paid API route or a weaker quality gate.
