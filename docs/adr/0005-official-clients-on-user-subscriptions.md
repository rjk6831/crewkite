# 0005. Connect only through official clients on the user's own subscriptions

- Status: Accepted
- Date: 2026-10-06, credit rules added 2026-10-10

## Context

I pay for subscriptions and want to use them from one place, within each provider's terms. Open-source proxies and OAuth tricks make it tempting to intercept credentials or substitute API billing.

## Decision

- CrewKite drives unmodified official clients through their supported interfaces. Users sign in through the client itself.
- CrewKite never collects, copies, remaps or logs provider credentials. Child environments exclude ambient API keys and billing overrides.
- Unknown billing blocks a route. There is no automatic fallback to paid API usage.
- Spending existing paid credits is off by default and enabled per provider, with a label that says whether the provider enforces a hard cap. CrewKite never buys credits or changes a plan.
- Subscription windows, API credits, local resources and CI minutes are separate cost domains and never combine.

## Why

Credential interception is a security and terms risk I will not take on behalf of users. A surprise API bill would defeat the reason the product exists.

## Consequences

- Each route needs dated qualification of client, account, model, effort, tools and billing. See [providers](../providers.md).
- Some controls are unavailable on some routes, and the UI says so.
- A client upgrade or account change can disable a route until it requalifies.
