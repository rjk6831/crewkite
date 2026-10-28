# 0044. Thread tools over one controller-owned MCP server

- Status: Proposed
- Date: 2026-10-28

## Context

[ADR 0042](0042-the-thread-is-the-source-of-truth-for-every-family.md) makes the thread the source of truth and sends each family a packet or a delta. A packet is a summary. A model that wants the full reply of an earlier turn, the trace of a command another family ran or the diff past the packet's budget has no way to ask. It guesses, or it reads files in the scratch copy and works backwards.

The three cloud clients each take MCP servers. Each also reads MCP servers from my own configuration, from project files and from plugins, so turning MCP on naively hands every turn whatever servers happen to be installed. Local runs through CrewKite's own agent loop and takes native function calls.

## Decision

The controller owns one MCP server, named `crewkite`, with five read-only tools over the current thread. Every other MCP source stays off.

- The server is a stdio entry in `apps/controller`. Each cloud client spawns it with `--thread <id> --token <one-time>`, and it connects back to the controller. The token is minted per turn and scoped to one thread. It ends with the turn.
- Anthropic launches with `--strict-mcp-config`, a config holding only this server, and `--allowedTools mcp__crewkite__*`. The OpenAI app-server gets a config with this one server. Google ACP gets this one entry in `session/new` `mcpServers`. A client setting that would load other servers is not passed.
- The tools and their bounds, enforced by the result schemas in `packages/contracts/src/chat.ts`:
  - `thread_turns({since?, family?, limit})`, limit at most 50. Each row: id, sequence, family, model, role, status, startedAt, endedAt, the first 300 characters of the reply and the changed file count.
  - `thread_turn({id})`. The reply up to 32 KiB with a truncated flag, the trace entries (kind, title, the path or command up to 500 characters, outcome) and the files changed.
  - `thread_diff({since?, path?, cursor?})`. A unified diff up to 64 KiB per call and a `more` cursor.
  - `thread_checks()`. The latest check lines, at most 64.
  - `thread_live()`. The running turn's family, role, elapsed time, the last 8 KiB of its text and its trace so far, or `none`.
- No tool writes. There is no tool for the scratch copy, the repository, settings or another thread.
- Secrets never leave the controller. Stdin bodies, environment values and anything typed into the token window are never in a result. Text matching `sk-`, `Bearer ` or an assignment to a name containing TOKEN, SECRET or KEY becomes `[redacted]` before the result is sent.
- Local gets the same five reads as native functions in `chat/local-tools.ts`. Local uses no MCP. Its results are cut further, to the room the Local prompt has left under the A5 budget rule.
- The full packet and the delta packet each gain one line: "Thread tools are available: thread_turns, thread_turn, thread_diff, thread_checks, thread_live."

## Why

The thread already holds everything these tools return. Letting a model ask for one turn or one diff page costs a tool call. Putting all of it in every packet would cost the context on every turn whether the model needs it or not.

I chose MCP because it is the one tool interface all three cloud clients take. A per-client tool shim would mean three adapters to keep in step.

I keep every other MCP source off because each server a turn loads is code that runs as me with whatever access it was written to have. The servers in my own configuration were set up for other work. [ADR 0002](0002-authority-in-deterministic-code.md) keeps authority in the controller. A turn that can call tools nobody chose for it breaks that. One server that the controller owns, with a token that dies with the turn, keeps the set of tools a turn can reach equal to the set I can read in this record.

The tools read only because reading another family's work is the gap. Writes already go through the client's own edit tools in the scratch copy, under the thread's permission policy. A second write path would need its own permission rules.

The bounds come from the packet caps. A 64 KiB diff page fits in any cloud context with room left, and the cursor reaches the rest. The 300 character reply preview keeps a 50 row list near 20 KiB.

Redaction is a pattern match, and I chose it knowing it misses things. The controller already never stores the token window or environment values, so the patterns are a second guard for text a model or a command printed.

## Consequences

- Each cloud turn starts one more process. The server is small, and it exits with the turn.
- My own MCP servers are not available inside CrewKite turns. I lose them on purpose. Using one means a new record.
- A model can now read every turn of the thread, including turns from other families. That was already true of the packet. The difference is depth.
- Redaction can miss a secret in a shape the patterns do not match. The tools return only what the thread already shows me.
- The attach path differs per client and depends on flags each client documents today. A client release that renames them breaks the attach, and the turn runs without the tools. The packet line still names them, so a model may try and fail.
- The Anthropic, OpenAI and Google attach paths and the Local functions have fixture coverage and no live run on record.
