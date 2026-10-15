# 0019. Defer team, remote and hosted features behind a transport seam

- Status: Accepted
- Date: 2026-10-07

## Context

Paid team orchestration and remote or mobile control are plausible futures. Building them now would delay the daily tool and add identity, tenancy and hosting obligations.

## Decision

Commands are transport-neutral and carry actor and host identity. The first releases keep one local, single-user authority. Team and remote features need explicit identity, tenancy and approval boundaries when I enable them.

## Why

The seam costs little now and keeps those options open. The features themselves cost a lot and serve no one until the local workflow proves itself.

## Consequences

- Personal provider subscriptions are never assumed shareable in a team product.
- A hosted control plane, relay or mobile client each gets its own ADR and gates.
