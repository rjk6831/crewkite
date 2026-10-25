# Local models and the context window

A local model on a laptop usually runs with a small context window. At a few thousand tokens one medium source file can fill it. The local runtime's own chat keeps every message and file you paste. When the window is full it stops or drops the oldest messages, depending on its overflow setting. CrewKite runs the agent loop for Local itself, so it decides what goes into each prompt. CrewKite holds no context size of its own. It reads the context from the loaded instance and sizes every budget from that number. This page explains how a repository task fits, how Local connects and gives a demo you can run. Setup and the tool bounds are under [Local](providers.md#local) in the provider routes.

## Connect

Local connects in one of three ways, and the card shows which one it used.

- With a token. The token lives in CrewKite's memory only, as [ADR 0025](adr/0025-use-an-explicit-memory-only-local-credential.md) describes. Settings asks for it in the native input window. After a relaunch it is gone, and Connect asks again. [ADR 0043](adr/0043-remember-the-local-token-on-this-mac.md) proposes an opt-in way to keep it on this Mac. It is not built.
- With no token. CrewKite probes the loopback address once per connect. When 127.0.0.1 answers without a token, it connects with none and the card reads "Connected without a token. The runtime has auth off on loopback."
- From the rail. Connect in the left rail connects in place with the saved host, port and authentication mode. It opens Settings only when the runtime asks for a token that CrewKite does not hold, and then Settings opens on the Local card with the token window already up.

## What the card shows

Before a connection the card and the model picker show the last observation, labelled "Last seen 2 h ago. Not connected.", with the controls disabled. A reconnect keeps that read on view, with the controls still off, until the first read on the new connection replaces it.

The card reads the runtime again on the open connection, with no token: when Settings opens, when the window gains focus, and every 15 seconds while Settings or the model picker is open. The SDK has no load or unload event to listen to. Refresh on the card runs the read now. The selected model survives a reconnect when a loaded instance has the same model key. Otherwise the selection clears and the card says, for example, "Model A is no longer loaded. Pick a model." "Model selection confirmed" appears only after a fresh read that includes the selected instance.

Local qualifies when the selected instance is loaded and its model is eligible. Other resident models do not disqualify it. The card lists every resident model with its size and context and marks the selected one. A turn binds to one instance reference, and only that instance receives it. A resident embedding model does not block Local either.

The hardware card shows Available memory, read once per observation with `vm_stat` as free plus inactive plus purgeable pages times the page size. When available memory is below 4 GiB or below 10 percent of unified memory, the card adds a line such as "Low memory: 1.2 GB available with 2 models loaded. Replies may slow." It is a warning and never blocks a turn.

## How a turn fits

C is the context the loaded instance reports. Every budget below is a fraction of C or follows from it. Every Local turn builds a fresh prompt from these parts:

| Part | Share | Rule |
|------|-------|------|
| Reply | R, set below | Reserved before anything else goes in |
| Framing and the request | What they measure | The tool rules, the bounds and your message. A request that does not fit gets one line with the counts and a smaller first step |
| Project outline | Up to 18% of C | Paths and exported symbols, most imported files first, cached per base commit |
| Rolling summary | About 300 tokens | Earlier turns folded into a short summary, when one exists |
| Recent turns | What is left | Newest first, until the next one would not fit |

### The reply budget

Before each turn, P is the prompt token count from the SDK tokenizer, and the reply budget is R = C - P - 256. The 256 is a margin. R has to be at least the larger of 2,048 and 30 percent of C. The 2,048 floor decides when C is below about 6,827, and the 30 percent decides above that.

- When the prompt leaves less than that, CrewKite runs the rolling summary first.
- When it still leaves less, CrewKite refuses the turn with one line that names the counts and proposes a smaller first step.
- The runtime is asked for at most R predicted tokens. Reasoning counts inside R.
- When the runtime exposes a reasoning budget for the loaded model, CrewKite caps it at half of R. When the runtime exposes only an on and off toggle, CrewKite leaves the toggle alone.

At 131,072 the floor is 39,322 tokens, so the prompt may use up to 91,494. The rule is the same at any size.

When a reply stops at the output limit, the thread shows a system line such as "Reply stopped at the output limit: 3,900 reasoning and 700 reply of 4,600 allowed." and offers Continue. Continue sends the turn "Continue the reply from where it stopped. Do not repeat what you already wrote." The partial reply stays in the thread.

### Reading the window

The model reads files in pieces. `read_range` returns at most 120 lines, `search` at most 30 hits cut to 200 characters each, and `run` the last 60 lines of output. A turn makes at most 12 tool calls. The prompt states each bound, so the model plans narrow reads.

Tool results stay inside the turn that asked for them. The next turn carries only what was said. When the framing, outline, earlier turns and the new reply come to more than 60% of C, CrewKite asks the model to fold the earlier turns into a summary of at most 300 tokens and stores it beside the task. The next prompt carries the summary in place of the turns it covers. A later fold extends the same summary. The thread keeps every raw turn; only the model's prompt is shorter. I chose 60% so the fold happens while there is still room to write it, and early enough that the next turn starts with space for tool results.

The work has to come in slices that fit. One file or one function per step works. A request for a sweeping change across a large module does not, because the model cannot hold the module while it edits. I accept that limit. The route is for bounded changes with a clear next step, and the outline plus search covers finding where those steps are.

## What the thread shows

Each finished Local turn ends with one stats line, for example `Context 6,097 of 32,768 · reasoning 1,310 · reply 640 · 2 summaries · 18 tok/s · 41.3 s`. Context is the last round's prompt plus its reply, the most of the window the turn used. Reasoning and reply split the generated tokens. Summaries counts the folds the prompt carried, including one written during the turn. Hover the line for tokens in, tokens out and time to first token. Turn time includes tool calls and permission waits.

When CrewKite writes or extends the summary, the turn shows a `Rolling summary` card, for example "Earlier turns 1 to 6 folded into a summary to fit the context."

## Demo

The demo runs the rule at a context of 8,192 tokens. It is the one case this page computes. With C = 8,192, the reply needs R of at least 2,458 (30 percent of C, which is above the 2,048 floor), so the prompt may use up to 5,478 tokens after the 256 margin. The outline takes up to 1,474 and the summary folds in once the carried conversation passes 4,915. A prompt of 5,100 tokens leaves R = 2,836, and the reasoning budget is capped at 1,418. A prompt of 5,600 leaves 2,336, so CrewKite folds the summary first.

The demo is a rename across three files in this repository: `cachedRepoMap` in `apps/controller/src/chat/repo-map.ts`, its import and call in `apps/controller/src/providers/local/chat.ts`, and its import and two calls in `apps/controller/src/chat/repo-map.test.ts`. The caller alone is about 39 KB, more than 10,000 tokens. The local runtime's own chat has no tools to read a file in pieces, so the three files have to be pasted in, and they do not fit an 8,192 token window. That chat cannot finish the task.

Set up first: load a 27B model in the local runtime with a context of 8,192 tokens, connect Local in Settings, open a thread on a checkout of this repository and pick the model in the composer. Leave the permission policy at Ask each time so each edit shows its diff before it lands.

Paste this as the first message:

```text
Rename the function cachedRepoMap to readRepoMap everywhere it appears. Work through these steps, one step per reply, and wait for me to say next before the following step.
1. Search for cachedRepoMap and list every place it appears with its path and line.
2. Rename the definition in apps/controller/src/chat/repo-map.ts.
3. Rename the import in apps/controller/src/providers/local/chat.ts.
4. Rename the call in apps/controller/src/providers/local/chat.ts.
5. Rename the import in apps/controller/src/chat/repo-map.test.ts.
6. Rename the two calls in apps/controller/src/chat/repo-map.test.ts.
7. Search for cachedRepoMap again and confirm nothing is left.
8. Run node --test apps/controller/src/chat/repo-map.test.ts and report the result.
After each edit, show the changed lines with a few lines around them and say which step comes next.
```

Send `next` after each reply. Approve each edit and the test command.

Expected result:

- Five or six edits in Changes across the three files, no `cachedRepoMap` left in the last search, and the test passing in the last reply.
- A `Rolling summary` card around the fifth or sixth step, when the quoted lines push the carried conversation past 60% of the window, and often a second one by the last step.
- On the later steps, a stats line close to `Context 6,097 of 8,192 · 2 summaries`. The context figure moves with how many lines the model reads and stays under 8,192. The summary count depends on how much the model writes per reply, so one summary is also a normal result.
- Between about 8 and 25 tok/s with a 4-bit quantization of the 27B model on Apple Silicon. Numbers vary by machine, quantization and what else is running.

If a turn ends with a line that names the counts and a smaller first step, the model read too much at once. Send the same step again. The new turn starts with no tool results in the window. If a reply stops at the output limit, choose Continue.

Live run pending. Until one is on record, the figures above are my estimate from the budget rules.
