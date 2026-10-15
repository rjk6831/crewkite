# 0006. Route work by remaining allowance and reset windows

- Status: Accepted
- Date: 2026-10-07, unit rules tightened 2026-10-12

## Context

My weekly resets fall on different days. A typical week: one subscription has 80% left with two days to go, another has 30% left and resets in two hours. The right move is to spend the expiring allowance first, hand off before it runs out, and return to my normal split after the reset. Today I do that arithmetic in my head and type the handoff myself.

## Decision

A deterministic router admits work only when every applicable window, reservation, slot and reserve allows it. Among eligible routes it applies my base order, then a bounded preference for allowance that resets soon. Pins and approved fallbacks outrank that preference. Hysteresis prevents small fluctuations from bouncing work between providers. [Usage and routing](../routing.md) has the full sequence and a worked example.

## Why

This is the exact juggling I want to stop doing by hand. A deterministic router lets me read why a route was chosen and which routes were rejected, and lets me test the rules with recorded inputs.

## Consequences

- Missing usage is unknown. A clock passing a reset time marks the window reset-pending until a fresh observation confirms it.
- A percentage needs a real denominator from the provider. Unlike units never sum into one gauge.
- When telemetry is stale, the user picks an explicit fallback rule and the UI shows which one is active.
- The router never starts busywork to consume quota.
