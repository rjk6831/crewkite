# Provider routes

I qualify exact routes: a specific client build, account type, model, effort setting and billing mode. A logo or a model name in a menu is not support. The current D0 prototype runs scripted fakes for all four families. No live provider route is qualified.

## Qualification targets

| Family | First route to qualify | Facts still to establish |
|--------|------------------------|--------------------------|
| OpenAI | Codex app-server with native login | Protocol behavior, approvals, tool boundary, billing once included usage runs out |
| Anthropic | Claude Code structured output stream | Subscription-preserving configuration, permission modes |
| Google | Antigravity CLI structured headless output | Subscription billing identity, native permissions, cancellation and recovery |
| Local | An authenticated loopback runtime such as LM Studio | Locality, memory use, a useful role, cancellation |

These are planned pilots. A fake family label does not establish a client's capabilities, authentication or billing behavior. The Local fixture loads no model.

Google [ended consumer sign-in for Gemini CLI on June 18, 2026](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals), including Google AI Pro and Ultra. That consumer subscription path is unavailable. Google's [migration guide points to Antigravity CLI](https://www.antigravity.google/docs/cli/gcli-migration).

The 16 October 2026 check on the M5 Mac found Anthropic client 2.1.301 authenticated through `claude.ai`. Its streams closed and owned process group was absent. This establishes a subscription authentication candidate. Account entitlement, plan and billing identity remain unverified.

## Anthropic writer preparation

The provider-local helpers project bounded authentication metadata and own a structured text proposal process. The writer requires an exact executable digest, model and session. A successful result must bind one attempt, the literal `net.mjs` path and the original content hash to at most 64 KiB of UTF-8 text. The five-minute deadline includes owned process cleanup. The writer applies no files and registers no route.

The launch uses transient [safe and restricted modes](https://code.claude.com/docs/en/cli-reference), requests no built-in tools and denies MCP tools with an empty strict MCP configuration. The init stream must report no MCP servers. The parser reports whether init tool and plugin lists are empty. Plugin metadata can include built-in components and does not establish external effects. Names and paths are discarded. Managed hooks can still apply despite the session's hook setting. These controls use the [native trust profile](adr/0009-native-client-trust-profile.md). Managed hook execution remains unknown.

Four synthetic tasks on 16 October 2026 ended with protocol refusals before returning a proposal. The second refusal identified a nonempty init plugin list. The third stopped on an unidentified frame after init; the fourth stopped on a user-role frame. Those native processes exited successfully. All owned process groups closed and were absent. No files were applied. The parser treats plugin-list presence as an observation and discards bounded, session-bound subscription metadata and top-level user-role output. These frames grant no permission or replacement authority. A proposal requires the final successful structured result. Reported extra usage enabled or in use stops the task; missing values remain unknown. The discarded third frame and fourth frame's content cannot be identified from retained diagnostics. Installed-client behavior, account entitlement, request-level billing and the six native pilot checks remain unqualified.

## Google writer preparation

The Google adapter reads [structured headless output](https://www.antigravity.google/docs/cli/headless) and returns a bounded file replacement tied to an attempt, relative path and original content hash. It requires an exact client identity and dated controller-owned admission evidence. It applies no file changes and registers no route. Its scripted fixture covers malformed output, session binding, refusal before launch and process cleanup.

The 16 October 2026 metadata check on the M5 Mac used client 1.4.0 and reported credit fallback disabled and request-review permissions. It completed with zero turns, closed streams and an absent owned process group. Account entitlement and subscription billing identity remain unverified. The adapter preserves the native authentication location, excludes ambient API and billing overrides, and uses the opt-in [native trust profile](adr/0009-native-client-trust-profile.md). It claims no tool absence. [Credit fallback settings](https://www.antigravity.google/docs/cli/credits/) are separate from subscription identity.

The [official changelog](https://antigravity.google/docs/changelog?tab=cli) records permission fixes in 1.1.11 and headless mode fixes in 1.1.12. The former installed 1.1.10 build is refused. A version floor alone cannot qualify a later build. No Google inference task or six-check native pilot has completed.

## OpenAI writer preparation

The provider-local parser follows the [Codex app-server](https://learn.chatgpt.com/docs/app-server) metadata transcript and [0.159.0 protocol fields](https://github.com/openai/codex/tree/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/app-server-protocol/src/protocol). It covers initialization, account metadata without a forced token refresh, rate-limit metadata and one bounded model catalog page. Replies must match the outstanding request. Missing or non-ChatGPT account metadata stops discovery before limits or models are requested. Native email, account IDs, credential fields and raw diagnostics are excluded from the projected output. Model and effort IDs remain bounded, untrusted provider text. The process owner checks the executable digest and native configuration, then requires closed streams and absent process groups before returning a result.

On 16 October 2026, client 0.163.0 on the M5 Mac completed that metadata transcript. It reported ChatGPT Pro, available ordinary usage and seven model entries. Both owned process groups closed and were absent. No thread, turn or inference task was submitted by that check.

The prepared writer requires Pro account metadata with ordinary usage available. It requests `gpt-6.1-sol` at low effort on the default service tier through one thread and one turn. The total deadline is at most 300 seconds, including metadata startup and owned cleanup. The proposal must bind the attempt, literal `net.mjs` path and original content hash to at most 64 KiB of UTF-8 text. A result requires a matching completed turn and quiescent processes. The writer applies no files and registers no route. Its native turn behavior remains unqualified.

One synthetic task was submitted on 16 October 2026. The adapter stopped with a protocol refusal after 20.874 seconds, before returning a replacement proposal. Both owned processes closed and their groups were absent. No files were applied. Live route qualification remains pending.

A live turn can include upstream retries and tool continuations. A turn cap does not establish an inference-request cap. [Included subscription usage can extend into available paid credits](https://learn.chatgpt.com/docs/pricing#credits-overview); an included-only hard limit remains unverified. Reported ordinary usage availability does not enforce that boundary. CrewKite bounds submitted tasks and elapsed time. It cannot count every upstream inference request.

## Applying a replacement

The source helper separately rechecks the full saved scratch manifest and the opened target before replacing one existing regular file. It refuses links, mismatched hashes and stale file metadata. It preserves permissions, truncates to the replacement length and syncs the file. Native provider output is not wired to this helper in the controller. A write failure can retain unverified scratch and requires explicit recovery.

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
- Paid-credit controls are planned. They will default off per provider and show whether the provider enforces a hard cap.
- CrewKite never buys credits, tops up an account or changes a plan.
- A code license on an open-source proxy or SDK never grants a right to reuse subscription credentials.

## Local models

Local inference is planned and optional. A qualified local route needs authenticated loopback access, narrow CORS and no remote redirect. The first planned profile for a 48 GB Apple Silicon machine permits one resident model and one generation at a time. Memory use, latency and quality need measurement before that profile grows. D0 establishes none of those runtime measurements.
