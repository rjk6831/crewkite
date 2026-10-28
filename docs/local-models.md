# Local models and the context window

A local model on a laptop usually runs with a small context window. At a few thousand tokens one medium source file can fill it. The local runtime's own chat keeps every message and file you paste. When the window is full it stops or drops the oldest messages, depending on its overflow setting. CrewKite runs the agent loop for Local itself, so it decides what goes into each prompt. CrewKite holds no context size of its own. It reads the context from the loaded instance and sizes every budget from that number. This page explains how a repository task fits, how Local connects and gives a demo you can run. Setup and the tool bounds are under [Local](providers.md#local) in the provider routes.

## Connect

Local connects with a token or with none, and the card shows which one it used.

- The probe. CrewKite probes the loopback address at the start of every Connect, in both saved modes. The probe never writes the saved mode. Its result lives on the connection and the card shows it as "Connected, no token" or "Connected", with the line "Connected without a token. The runtime has auth off on loopback." when the runtime answered with none. A probe that times out gets one more try, 2 seconds each, before CrewKite decides a token is needed. The turn trace records what the probe found.
- Saved mode Token, runtime with auth off. Connect finishes with no token window and the saved mode stays Token.
- Saved mode No token, runtime that now wants a token. Connect opens the token window for this connection and the saved mode stays No token.
- With a token. The token lives in CrewKite's memory, as [ADR 0025](adr/0025-use-an-explicit-memory-only-local-credential.md) describes. Connect asks for it in the native input window. After a relaunch it is gone and Connect asks again, unless I turned on Remember on this device, described below. Cancel in the token window is a known outcome. Local stays not connected, the card says "Connection input closed. Local is not connected." and no uncertain-outcome banner appears.
- From the rail. Connect in the left rail connects in place with the saved host, port and mode. It opens Settings only when the runtime asks for a token that CrewKite does not hold, and then Settings opens on the Local card with the token window already up. Local is on the rail even before an endpoint is saved. Then its row reads "Set up" and opens the Local card.

Every Connect clears the status lines from the attempt before it, so the card never shows a stale line beside a new result.

### The authentication switch

The Authentication control on the card has two options, "Token" and "No token (loopback only)". It writes the saved mode through the same command the CLI uses, with the same checks. A change clears the connection and the model selection, and the card says "Authentication setting saved. Press Connect." I added the switch because I change the runtime's auth setting in its own window, and a trip to the terminal to tell CrewKite the same thing was the step I skipped. [ADR 0043](adr/0043-remember-the-local-token-on-this-device.md) records this change to ADR 0025.

### Remember on this device

After a connect with a token, the card offers "Remember on this device". It is off by default. The main process encrypts the token with the operating system's secret storage and keeps the encrypted blob in a file on this device. The renderer never receives the token. On the next Connect the main process decrypts it and hands it to the controller in memory, and the token window does not open. The card then reads "The token is kept on this device for this endpoint." and the button reads "Forget". Forget deletes the blob and clears the controller's copy, and the card says "The kept token is removed from this device." Disconnect keeps the blob.

The blob belongs to one endpoint in Token mode. A different host or port does not find it, and a changed endpoint or a switch to No token deletes it.

The option is offered only when the storage really encrypts. On Linux the fallback backend is `basic_text`, which uses a fixed key, so a blob under it is a plain file with extra steps. There the option is hidden and the card says "This device has no keychain that encrypts stored secrets, so the token is asked for each launch." The token is asked for at each launch, as before. This is the one secret CrewKite can keep, and it is the token of a runtime on this device, not a provider credential.

## What the card shows

Before a connection the card and the model picker show the last observation, labelled "Last seen 2 h ago. Not connected.", with the controls disabled. A reconnect keeps that read on view, with the controls still off, until the first read on the new connection replaces it.

The card reads the runtime again on the open connection, with no token: when Settings opens, when the window gains focus, and every 15 seconds while Settings or the model picker is open. The SDK has no load or unload event to listen to. Refresh on the card runs the read now. The selected model survives a reconnect when a loaded instance has the same model key. Otherwise the selection clears and the card says, for example, "Model A is no longer loaded. Pick a model." "Model selection confirmed" appears only after a fresh read that includes the selected instance.

A read the card starts on its own posts no line. The card keeps one current status line, and only a change produces a new one: a model loaded, a model unloaded or the selection lost. Sizes read the same everywhere, for example "22.5 GB".

Local qualifies when the selected instance is loaded and its model is eligible. Other resident models do not disqualify it. The card lists every resident model with its size and context and marks the selected one. A turn binds to one instance reference, and only that instance receives it. A resident embedding model does not block Local either.

A loaded instance that is busy with another request shows `Busy` beside its state. A kept selection stays on it, the controls stay on and the instance still qualifies. The turn waits for the instance to free up.

The hardware card shows Available memory, read with `vm_stat` as free plus inactive plus purgeable pages times the page size. The first read starts at launch, so the card has a figure before Local connects. When available memory is below 4 GiB or below 10 percent of unified memory, the card adds a line such as "Low memory: 1.2 GB available with 2 models loaded. Replies may slow." It is a warning and never blocks a turn.

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

At 8,192 the floor is 2,458 tokens, so the prompt may use up to 5,478. At 131,072 the floor is 39,322, so the prompt may use up to 91,494. The rule is the same at any size, and a file proposal uses it too.

When a reply stops at the output limit, the thread shows a system line such as "Reply stopped at the output limit: 3,900 reasoning and 700 reply of 4,600 allowed." and offers Continue. Continue sends the turn "Continue the reply from where it stopped. Do not repeat what you already wrote." The partial reply stays in the thread.

### Reading the window

The model reads files in pieces. `read_range` returns at most 120 lines, `search` at most 30 hits cut to 200 characters each, and `run` the last 60 lines of output. A turn makes at most 12 tool calls. The prompt states each bound, so the model plans narrow reads.

Tool results stay inside the turn that asked for them. The next turn carries only what was said. When the framing, outline, earlier turns and the new reply come to more than 60% of C, CrewKite asks the model to fold the earlier turns into a summary of at most 300 tokens and stores it beside the task. The next prompt carries the summary in place of the turns it covers. A later fold extends the same summary. The thread keeps every raw turn; only the model's prompt is shorter. I chose 60% so the fold happens while there is still room to write it, and early enough that the next turn starts with space for tool results.

The work has to come in slices that fit. One file or one function per step works. A request for a sweeping change across a large module does not, because the model cannot hold the module while it edits. I accept that limit. The route is for bounded changes with a clear next step, and the outline plus search covers finding where those steps are.

## What the controller does for a small context

A small window is a fact about the loaded instance, so the controller plans around it. The rest of this page gives each rule. This section lists them in the order a large task meets them. A task over the loaded model's context fails in the runtime's own chat, because that chat holds every message and file in the window. The same task completes in CrewKite through folding and slices. [Live run pending](#demo).

- Folding. When the framing, the outline, the earlier turns and the new reply come to more than 60% of the window, the controller asks the model for a summary of at most 300 tokens and stores it beside the task. The next prompt carries the summary in place of the turns it covers, and a later fold extends it. The thread keeps every raw turn. A `Rolling summary` card in the thread marks each fold.
- The file proposal. When the model returns the full new text of one file, the controller reads the context from the bound instance. The output cap is the smallest reply the rule allows, 2,458 tokens at 8,192, and the reasoning cap is half of that, 1,229. The prompt shrinks until the prompt, the cap and the 256 margin fit. When they cannot fit, the proposal is refused before the model runs. The profile holds no fixed cap.
- The bounded tool loop. The model reads in pieces: 120 lines a read, 30 search hits, the last 60 lines of command output. A turn makes at most 12 tool calls. The call after the twelfth gets "The limit of 12 tool calls for this turn is reached. Do not call tools again. Answer now with what you found." Each bound sits in the prompt, so the model plans narrow reads.
- The fit check for slices. When an orchestrator plan has an easy slice, the controller asks whether Local can take it. The slice fits when none of its files is an image and its named files come to no more than the prompt room after the outline and the summary take their share. The check counts one token for every 3 bytes, which never undercounts text or code. At 8,192 the prompt room is 5,478, the outline takes up to 1,474 and the summary 300, so the files may come to about 3,700 tokens, or 11,100 bytes. A slice that fits goes to Local first. A slice that names a larger file, such as the 39 KB caller in the demo, goes to the top-ranked family. Every assignment writes a system line with the reason, for example "Slice 2 (easy) assigned to Local: 5,478 token room, Local first."
- The thread tools. Local gets the five thread reads as functions: `thread_turns`, `thread_turn`, `thread_diff`, `thread_checks` and `thread_live`. They are read-only and use no MCP. Each result is cut to the room the prompt has left, and a cut result ends with "[cut to fit the Local context; ask for less]" so the model asks again for less. A model that ran after another family can read what that family did without the packet carrying all of it. [ADR 0044](adr/0044-thread-tools-over-one-controller-owned-mcp-server.md) records the tools.

I accept the limit that a slice has to be small. The orchestrator cuts the work, the fit check keeps a slice inside what the window can hold, and a larger slice goes to a family with more room.

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
