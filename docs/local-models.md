# Local models at 8,192 tokens

A local model on a laptop usually runs with a small context window. At 8,192 tokens one medium source file can fill it. The local runtime's own chat keeps every message and file you paste. When the window is full it stops or drops the oldest messages, depending on its overflow setting. CrewKite runs the agent loop for Local itself, so it decides what goes into each prompt. This page explains how a repository task fits and gives a demo you can run. Setup and the tool bounds are under [Local](providers.md#local) in the provider routes.

## How a turn fits

Every Local turn builds a fresh prompt from parts with fixed shares of the window:

| Part | Share at 8,192 | Rule |
|------|----------------|------|
| Reply | 2,048 tokens | A quarter of the window, held back before anything else goes in |
| Framing and the request | What they measure | The tool rules, the bounds and your message. A request that does not fit gets one line asking for a smaller first step |
| Project outline | Up to 1,474 tokens | Paths and exported symbols, most imported files first, cut to 18% of the window and cached per base commit |
| Rolling summary | About 300 tokens | Earlier turns folded into a short summary, when one exists |
| Recent turns | What is left | Newest first, until the next one would not fit |

The model reads files in pieces. `read_range` returns at most 120 lines, `search` at most 30 hits cut to 200 characters each, and `run` the last 60 lines of output. A turn makes at most 12 tool calls. The prompt states each bound, so the model plans narrow reads.

Tool results stay inside the turn that asked for them. The next turn carries only what was said. When the framing, outline, earlier turns and the new reply come to more than 60% of the window, CrewKite asks the model to fold the earlier turns into a summary of at most 300 tokens and stores it beside the task. The next prompt carries the summary in place of the turns it covers. A later fold extends the same summary. The thread keeps every raw turn; only the model's prompt is shorter. I chose 60% so the fold happens while there is still room to write it, and early enough that the next turn starts with space for tool results.

The work has to come in slices that fit. One file or one function per step works. A request for a sweeping change across a large module does not, because the model cannot hold the module while it edits. I accept that limit. The route is for bounded changes with a clear next step, and the outline plus search covers finding where those steps are.

## What the thread shows

Each finished Local turn ends with one stats line, for example `Context 6,097 of 8,192 · 2 summaries · 18 tok/s · 41.3 s`. Context is the last round's prompt plus its reply, the most of the window the turn used. Summaries counts the folds the prompt carried, including one written during the turn. Hover the line for tokens in, tokens out and time to first token. Turn time includes tool calls and permission waits.

When CrewKite writes or extends the summary, the turn shows a `Rolling summary` card: "Earlier turns 1 to 6 folded into a summary to fit 8,192 tokens."

## Demo

The demo is a rename across three files in this repository: `cachedRepoMap` in `apps/controller/src/chat/repo-map.ts`, its import and call in `apps/controller/src/providers/local/chat.ts`, and its import and two calls in `apps/controller/src/chat/repo-map.test.ts`. The caller alone is about 39 KB, more than 10,000 tokens. The local runtime's own chat has no tools to read a file in pieces, so the three files have to be pasted in, and they do not fit an 8,192 token window. That chat cannot finish the task.

Set up first: load a 27B model in the local runtime with an 8,192 token context, connect Local in Settings, open a thread on a checkout of this repository and pick the model in the composer. Leave the permission policy at Ask each time so each edit shows its diff before it lands.

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

If a turn ends with "The turn filled the Local model's 8,192 token context", the model read too much at once. Send the same step again. The new turn starts with no tool results in the window.

Live run pending. Until one is on record, the figures above are my estimate from the budget rules.
