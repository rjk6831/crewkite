# Provider routes

I qualify exact routes: a specific client build, account type, model, effort setting and billing mode. A logo or a model name in a menu is not support. The current D0 prototype runs scripted fakes for all four families. No live provider route is qualified.

## Qualification targets

| Family | First route to qualify | Facts still to establish |
|--------|------------------------|--------------------------|
| OpenAI | Codex app-server with native login | Protocol behavior, approvals, tool boundary, billing once included usage runs out |
| Anthropic | Claude Code structured output stream | Subscription-preserving configuration, permission modes |
| Google | Gemini CLI in ACP mode with a Google account | Approval and cancel behavior, which billing path applies |
| Local | An authenticated loopback runtime such as LM Studio | Locality, memory use, a useful role, cancellation |

These are planned pilots. A fake family label does not establish a client's capabilities, authentication or billing behavior. The Local fixture loads no model.

## OpenAI discovery preparation

The controller has a fixture-tested parser for the [Codex app-server](https://learn.chatgpt.com/docs/app-server) metadata transcript, pinned to [0.159.0 protocol fields](https://github.com/openai/codex/tree/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/app-server-protocol/src/protocol). It covers initialization, account metadata without a forced token refresh, rate-limit metadata and one bounded model catalog page. Replies must match the outstanding request. Missing or non-ChatGPT account metadata stops discovery before limits or models are requested. Native email, account IDs, credential fields and raw diagnostics are excluded from the projected output. Model and effort IDs remain bounded, untrusted provider text.

This module launches no process, performs no network or filesystem work and is not registered as a route. Completing its transcript establishes metadata only. It proves no authentication, billing, process completion or live-provider qualification.

A live turn can include upstream retries and tool continuations. A turn cap does not establish an inference-request cap. [Included subscription usage can extend into available paid credits](https://learn.chatgpt.com/docs/pricing#credits-overview); an included-only hard limit remains unverified. Both limits block live dispatch.

## Qualification

A route is qualified when dated evidence covers:

- The exact executable and its digest, the OS and the client version
- Authentication through the client's own supported login
- Model, native effort levels and which settings the route can enforce
- Tool and file boundaries, including denial of paths outside the scratch copy
- Approval correlation, interruption and stop behavior
- Billing mode, including what happens after included usage runs out

Each fact is recorded as supported, unsupported or unknown. Discovery spends no inference. An upgrade or account change requalifies the facts it can affect.

## Boundaries I hold for every route

- CrewKite never collects, copies, remaps or logs provider credentials.
- Ambient API keys and billing overrides are excluded from child environments.
- Unknown billing blocks the route. There is no hidden fallback to paid API usage.
- Using existing paid credits is off by default per provider. When enabled, the card states whether the provider enforces a hard cap.
- CrewKite never buys credits, tops up an account or changes a plan.
- A code license on an open-source proxy or SDK never grants a right to reuse subscription credentials.

## Local models

Local inference is planned and optional. A qualified local route needs authenticated loopback access, narrow CORS and no remote redirect. The first planned profile for a 48 GB Apple Silicon machine permits one resident model and one generation at a time. Memory use, latency and quality need measurement before that profile grows. D0 establishes none of those runtime measurements.
