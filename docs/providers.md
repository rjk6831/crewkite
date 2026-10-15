# Provider routes

CrewKite drives the official clients you already use and pay for. It supports exact routes: a specific client build, account type, model, effort setting and billing mode. A logo or a model name in a menu is not support.

## Route families

| Family | First route to qualify | Facts still to establish |
|--------|------------------------|--------------------------|
| OpenAI | Codex app-server with native login | Protocol behavior, approvals, tool boundary, billing once included usage runs out |
| Anthropic | Claude Code structured output stream | Subscription-preserving configuration, permission modes |
| Google | Gemini CLI in ACP mode with a Google account | Approval and cancel behavior, which billing path applies |
| Local | An authenticated loopback runtime such as LM Studio | Locality, memory use, a useful role, cancellation |

No route is qualified today. The D0 prototype uses scripted fakes for all four families.

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

Local inference is optional. Every feature works with no local route configured. When one is configured, it needs authenticated loopback access, narrow CORS and no remote redirect. The first profile on a 48 GB Apple Silicon machine runs one resident model and one generation at a time, and grows as measured memory, latency and quality allow.
