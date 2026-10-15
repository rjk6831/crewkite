# 0003. Use TypeScript, React and Electron with a separate Node controller

- Status: Accepted
- Date: 2026-10-10, adoption proof added 2026-10-12

## Context

The first prototype was Python. I dropped that constraint on 7 October so the stack could be chosen on evidence. I evaluated an Electron shell, a Tauri shell, a Python local web app, forking an existing agent desktop app, and building on DeepSeek Harness.

## Decision

- A new Electron shell with a React renderer.
- A headless Node controller in its own process. The desktop app and the CLI are equal clients of it.
- TypeScript everywhere, with runtime schemas shared through `packages/contracts`.
- One bounded adoption proof of DeepSeek Harness at a pinned revision. Its outcome changes this ADR only through an explicit amendment.

## Why

One language across controller, clients and contracts lets every process validate the same schemas. A separate controller keeps authority out of the renderer and makes the CLI a first-class client. Electron gives me the renderer isolation controls I need and mature components for diffs, terminals and accessibility.

Forking an agent desktop app would also adopt its authority model, which conflicts with ADR 0002. The Harness is the strongest foundation candidate I found, with shared GUI and CLI machinery and replaceable providers. Its native child bundles run as unattended one-shot jobs without resume, a mismatch for the supervised launch-and-continue journey. One pinned proof settles that question without another round of comparisons.

## Consequences

- Packaging bundles a pinned Node runtime for the controller. The controller never depends on the developer's PATH or on Electron's embedded runtime.
- Building the UI from scratch costs real time. I accept that cost.
- The adoption proof concludes adopt, reuse selected components, or continue building, and records the deciding evidence.
