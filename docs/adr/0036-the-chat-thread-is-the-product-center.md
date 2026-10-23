# 0036. The chat thread is the product center

- Status: Proposed
- Date: 2026-10-23

## Context

The first conversation I built was a one-shot structured job. A planning turn opened an ephemeral read-only OpenAI thread, sent the whole history as JSON in one prompt with an output schema, and accepted only a final message that parsed against that schema. The prompt told the model it could not run tools or commands, edit files or delegate. Streamed text and reasoning arrived and were discarded. The person saw a worker start and stop.

The turn also failed on facts unrelated to the request. Admission refused on the account plan and on MCP servers enabled in the person's own client. The transcript pinned literal values of the client's session settings, and the clients ship weekly, so an update could end a working turn with `protocol` and no cause. The Anthropic usage reader pinned its metadata the same way. The cause was built in memory and dropped before it reached the person.

Repository context came through separate Inspect, Capture and Attach actions with small byte limits. Sending one message took a saved team, a frozen offer, three steps and a consent sentence.

## Decision

A thread is a streamed agent session on one scratch copy of the project. A turn is one user message and the provider's response. The provider's tools read the repository, edit the copy and run commands while the person watches.

Every adapter emits one event contract, `AgentEvent` in `packages/contracts/src/chat.ts`. The controller validates each event, stores it in the event log and forwards it. The renderer reads that contract and nothing provider-specific.

I chose four adapters behind `ChatAdapter`: the OpenAI client's app-server over stdio with a persistent thread, the Anthropic client in print mode with stream-json in and out and session resume, Google's published ACP agent, and Local through the runtime's SDK with CrewKite's own bounded tools, repo map and rolling summary. Each uses the official client on the person's own subscription under [ADR 0005](0005-official-clients-on-user-subscriptions.md) and [ADR 0024](0024-integrate-google-through-its-published-acp-agent.md). Adapters parse the fields they use and ignore the rest. An unknown notification becomes one notice per turn.

Permission requests appear in the thread. `ResolveChatPermission` answers one, and the controller accepts only a request that is open on the active turn and an option that request offered. A per-thread policy of ask each time, allow edits or allow all sets what an adapter may answer for itself. A new thread asks every time. [ADR 0002](0002-authority-in-deterministic-code.md) stands.

A handoff builds the next provider's first prompt from stored facts: the transcript, the changed files and the new message. The work stays in the same scratch copy. I never ask the stopped model to summarize itself, as [ADR 0007](0007-recover-from-durable-facts.md) requires.

A failed turn ends with its stage, its cause, the provider's own message and a next action. `protocol` is never the text the person reads.

The structured planning turn is removed.

## Why

I ruled out adding streaming to the structured turn. The schema fixes the shape of the answer and the prompt forbids tools, so streaming would show a form being filled in and leave the model blind to the repository.

I ruled out driving each provider through its API. [ADR 0005](0005-official-clients-on-user-subscriptions.md) keeps CrewKite on official clients and the person's own subscription, and that has not changed.

OpenAI, Anthropic and Google clients already run their own agent loop and approval channel, so those adapters translate. Local has no loop, so CrewKite writes a small one with bounded tools. [ADR 0029](0029-native-repository-context-and-handoff.md) weighs a larger context subsystem for Local. I build the repo map, the bounded tools and the rolling summary first and measure them before I add an index.

One event contract means a client update or a fifth adapter touches one file and the renderer stays as it is. Tolerant parsing follows from the release rate of the clients. A literal pin on a field CrewKite never acts on turns an update into an outage.

Asking in the thread removes the consent sentence per message and leaves the decision with the controller.

## Consequences

- The structured planning path is removed: the planning conversation commands, the OpenAI, Anthropic and shared conversation modules, and the renderer files only they used. Their tables stay in the schema because migrations only append.
- Tests follow. Tests that protected only the removed paths go in the same change. The claims move to the chat path: adapters against scripted peers, the service against a scripted adapter and one desktop journey.
- The roster becomes roles inside the thread. A Reviewer or Advisor answers in the same thread with a badge and one provider and model behind it. Team offers, frozen preparation and per-message consent are not part of the chat path.
- Permission moves from a frozen consent per run to a policy per thread. A thread set to allow all gives up the prompt for the requests an adapter can answer itself. Edits still land only in the scratch copy.
- Every adapter has fixture coverage and no live run on record. [Provider routes](../providers.md) says Live qualification pending for each. A client update can still break a frame I assumed, and a live run on the pinned client is what confirms them.
- The thread has no accept action yet. Edits stay in the scratch copy until branch acceptance under [ADR 0008](0008-isolated-writers-local-branch-acceptance.md) is wired into it.
- ADR 0029 stays Proposed. It describes more than I am building now, and I will amend or supersede it when I decide how much of it Local needs.
